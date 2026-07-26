/* eslint-disable no-await-in-loop */

import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
} from 'discord.js'
import dotenv from 'dotenv'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import axios from 'axios'

import * as utils from './utils.js'
import {
  absoluteMediaUrl,
  buildMemeSearchQuery,
  defaultMemeMessageCommandName,
  defaultMemeSlashCommandName,
  isMemeSlashCommand,
  isMemeSearchCommand,
  legacyMemeSlashCommandNames,
  mediaFilenamesFromMessages,
  memeMessageCommandDefinition,
  memeSlashCommandDefinition,
  memeSearchOptionName,
  nonNegativeNumber,
  positiveInteger,
  selectMemeSearchResult,
} from './memeCommand.js'
import {
  createGeminiMemeQueryClient,
  defaultMemeQueryModel,
  generateMemeSearchQuery,
} from './memeQuery.js'

const maxFilenameLength = 123
const additionalExtensions = ['mp3', 'wav', 'ogg']

dotenv.config()

const memeChannelId = process.env.MEME_CHANNEL_ID
const token = process.env.DISCORD_BOT_TOKEN
const uploadDirectory = process.env.UPLOAD_DIR || 'public/'
const htaccessPath = process.env.HTACCESS_PATH || 'public/.htaccess'
const indexPath = process.env.INDEX_PATH || 'public/indeksi.csv'
const memeSearchUrl = process.env.MEME_SEARCH_URL || 'http://search:3000/api/search'
const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://kaatis.party'
const memeContextLimit = positiveInteger(process.env.MEME_CONTEXT_LIMIT, 10)
const memeFetchLimit = positiveInteger(process.env.MEME_FETCH_LIMIT, 12)
const memeQueryMaxLength = positiveInteger(process.env.MEME_QUERY_MAX_LENGTH, 480)
const memeSearchLimit = positiveInteger(process.env.MEME_SEARCH_LIMIT, 6)
const memeRandomPoolLimit = positiveInteger(process.env.MEME_RANDOM_POOL_LIMIT, 4)
const memeRandomScoreDelta = nonNegativeNumber(process.env.MEME_RANDOM_SCORE_DELTA, 0.035)
const memeSearchLogContext = process.env.MEME_SEARCH_LOG_CONTEXT !== 'false'
const memeQueryModel = process.env.GEMINI_QUERY_MODEL || defaultMemeQueryModel
const discordGuildId = process.env.DISCORD_GUILD_ID || ''
const registerSlashCommands = process.env.DISCORD_REGISTER_SLASH_COMMANDS !== 'false'
const memeSlashCommandName = defaultMemeSlashCommandName
const searchInternalToken = process.env.SEARCH_INTERNAL_TOKEN || ''
const allowedWebhookIds = (process.env.ALLOWED_WEBHOOK_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)

const botMessages = {
  uploadError: 'Tiedostoasi ei voitu lähettää kaatikseen',
  invalidExtension: 'sen pääte on virheellinen',
  tooBigFile: 'se on kooltaan liian suuri',
  memeSearchNoContext: 'Tarvitsen pari viimeaikaista viestiä ennen kuin osaan valita meemin',
  memeSearchNoResults: 'En löytänyt tähän sopivaa meemiä tällä kertaa',
  memeSearchMissingAccess: 'En pysty lukemaan tämän kanavan viestihistoriaa. Anna botille Näytä kanava ja Lue viestihistoria -oikeudet.',
  memeSearchError: 'En pystynyt hakemaan meemejä juuri nyt',
}
let memeQueryAi

// Message/channel partials make messageDelete fire for messages that
// aren't in the cache (e.g. anything uploaded before the last bot restart).
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
})

// Returns filenames from the index that belong to the given message ID.
// Rows without a 4th column (old uploads) are ignored.
async function filenamesForMessage(messageId) {
  try {
    const lines = (await fsp.readFile(indexPath, 'utf8')).split('\n')
    const filenames = []
    for (const line of lines) {
      const fields = line.match(/"([^"]*)"/g)
      if (fields && fields.length >= 4 && fields[3].slice(1, -1) === messageId) {
        filenames.push(fields[0].slice(1, -1))
      }
    }
    return filenames
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

// Rewrites the file keeping only the lines for which shouldRemove returns false.
// A missing file is treated as already clean.
async function removeLines(filePath, shouldRemove) {
  try {
    const content = await fsp.readFile(filePath, 'utf8')
    const filtered = content
      .split('\n')
      .filter((line) => !shouldRemove(line))
      .join('\n')
    await fsp.writeFile(filePath, filtered)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

// Removes the given uploaded files from disk and scrubs their .htaccess and
// index entries in a single rewrite each. Safe to call for files that were
// never fully created (e.g. rolling back a failed upload): a missing file or
// absent metadata line is simply ignored.
async function removeUploads(filenames) {
  const set = new Set(filenames)
  if (set.size === 0) return

  for (const filename of set) {
    try {
      await fsp.unlink(path.join(uploadDirectory, filename))
    } catch (e) {
      // A missing file is expected during rollback; surface anything else
      if (e.code !== 'ENOENT') console.error(`Tiedoston ${filename} poisto epäonnistui: ${e.message}`)
    }
  }

  // .htaccess lines end with the filename; index rows start with "filename",
  await removeLines(htaccessPath, (line) => set.has(line.split(' ').pop()))
  await removeLines(indexPath, (line) => {
    const match = line.match(/^"([^"]*)",/)
    return match !== null && set.has(match[1])
  })
}

async function memeCommandGuildId() {
  if (discordGuildId) return discordGuildId

  const channel = await client.channels.fetch(memeChannelId)
  return channel?.guildId || channel?.guild?.id || ''
}

async function upsertApplicationCommand({ applicationId, guildId, command }) {
  const rest = new REST({ version: '10' }).setToken(token)
  const commandsRoute = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId)
  const commands = await rest.get(commandsRoute)
  const existing = commands.find((candidate) => (
    candidate.name === command.name
    && candidate.type === command.type
  ))

  if (existing) {
    const commandRoute = guildId
      ? Routes.applicationGuildCommand(applicationId, guildId, existing.id)
      : Routes.applicationCommand(applicationId, existing.id)
    await rest.patch(commandRoute, { body: command })
    return 'updated'
  }

  await rest.post(commandsRoute, { body: command })
  return 'created'
}

async function deleteApplicationCommandByName({
  applicationId,
  guildId,
  name,
  type,
}) {
  const rest = new REST({ version: '10' }).setToken(token)
  const commandsRoute = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId)
  const commands = await rest.get(commandsRoute)
  const existing = commands.find((candidate) => (
    candidate.name === name
    && candidate.type === type
  ))

  if (!existing) return false

  const commandRoute = guildId
    ? Routes.applicationGuildCommand(applicationId, guildId, existing.id)
    : Routes.applicationCommand(applicationId, existing.id)
  await rest.delete(commandRoute)
  return true
}

async function deleteLegacyMemeSlashCommands({ applicationId, guildId }) {
  const legacyNames = legacyMemeSlashCommandNames
    .filter((name) => name !== memeSlashCommandName)
  if (legacyNames.length === 0) return

  const cleanupGuildIds = guildId ? [guildId, ''] : ['']
  for (const cleanupGuildId of cleanupGuildIds) {
    const scopeText = cleanupGuildId ? `guildistä ${cleanupGuildId}` : 'globaalisti'
    for (const name of legacyNames) {
      const removed = await deleteApplicationCommandByName({
        applicationId,
        guildId: cleanupGuildId,
        name,
        type: 1,
      })

      if (removed) {
        console.log(`poistettu /${name} vanha slash-komento ${scopeText}`)
      }
    }
  }
}

async function registerMemeCommands() {
  if (!registerSlashCommands) return

  const applicationId = client.application?.id || client.user.id
  const guildId = await memeCommandGuildId()
  const commands = [
    memeSlashCommandDefinition(memeSlashCommandName),
    memeMessageCommandDefinition(),
  ]

  const scopeText = guildId ? `guildiin ${guildId}` : 'globaalisti'
  for (const command of commands) {
    const action = await upsertApplicationCommand({
      applicationId,
      guildId,
      command,
    })
    const actionText = action === 'updated' ? 'päivitetty' : 'luotu'
    const typeText = command.type === 3 ? 'viestikomento' : 'slash-komento'
    const commandText = command.type === 3 ? command.name : `/${command.name}`
    console.log(`${actionText} ${commandText} ${typeText} ${scopeText}`)
  }

  await deleteLegacyMemeSlashCommands({ applicationId, guildId })
}

async function replyTemporarily(message, text) {
  const reply = await message.reply(text)
  setTimeout(() => reply.delete().catch(() => {}), 30000)
}

async function editInteractionTemporarily(interaction, text) {
  await interaction.editReply(text)
  setTimeout(() => interaction.deleteReply().catch(() => {}), 30000)
}

function canReadChannelHistory(channel) {
  const permissions = channel?.permissionsFor?.(client.user)
  if (!permissions) return true

  return permissions.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ])
}

function logMemeSearch(payload) {
  if (!memeSearchLogContext) return
  const entry = {
    event: 'meemihaku',
    timestamp: new Date().toISOString(),
    ...payload,
  }
  console.log(`Meemihaku\n${JSON.stringify(entry, null, 2)}`)
}

function getMemeQueryAi() {
  if (!memeQueryAi) {
    memeQueryAi = createGeminiMemeQueryClient({
      apiKey: process.env.GEMINI_API_KEY,
    })
  }

  return memeQueryAi
}

async function buildSearchQueryForMessages({ messages, fallbackQuery }) {
  try {
    return await generateMemeSearchQuery({
      ai: getMemeQueryAi(),
      model: memeQueryModel,
      messages,
      fallbackQuery,
      limit: memeContextLimit,
      maxLength: Math.min(memeQueryMaxLength, 160),
    })
  } catch (e) {
    console.error(`Gemini-hakukyselyn muodostus epäonnistui: ${e.message}`)
    return {
      query: fallbackQuery,
      source: 'fallback',
      prompt: '',
      rawText: '',
      error: e.message,
    }
  }
}

const normalizeSearchQuery = (query) => String(query || '').replace(/\s+/g, ' ').trim()

const serializeSearchResult = (result) => ({
  filename: result.filename || '',
  url: result.url || '',
  score: result.score ?? null,
})

async function searchMemeByQuery({
  query,
  excludedFilenames = [],
  logPayload = {},
}) {
  const normalizedQuery = normalizeSearchQuery(query)
  if (!normalizedQuery) return { status: 'no_context' }

  const { data } = await axios.get(memeSearchUrl, {
    headers: searchInternalToken
      ? { 'x-kaatis-internal-token': searchInternalToken }
      : undefined,
    params: {
      q: normalizedQuery,
      limit: memeSearchLimit,
      cache: 0,
      exclude: excludedFilenames.join(','),
    },
    timeout: 15000,
  })
  const candidates = data.results || []
  const {
    result,
    pool: selectionPool,
    selectedIndex,
  } = selectMemeSearchResult(candidates, {
    scoreDelta: memeRandomScoreDelta,
    maxPoolSize: memeRandomPoolLimit,
  })

  if (!result?.url && !result?.filename) return { status: 'no_results' }

  logMemeSearch({
    ...logPayload,
    query: normalizedQuery,
    excludedFilenames,
    candidateResults: candidates.map(serializeSearchResult),
    selectionPool: selectionPool.map(serializeSearchResult),
    selectedIndex,
    randomScoreDelta: memeRandomScoreDelta,
    result: serializeSearchResult(result),
  })

  return {
    status: 'found',
    url: absoluteMediaUrl({
      publicBaseUrl,
      mediaUrl: result.url || `/${result.filename}`,
    }),
  }
}

async function recentBotResultFilenames(channel) {
  if (!channel?.messages?.fetch) return []

  try {
    const fetchedMessages = await channel.messages.fetch({ limit: memeFetchLimit })
    return mediaFilenamesFromMessages({
      publicBaseUrl,
      messages: Array.from(fetchedMessages.values()).filter((candidate) => (
        candidate.author?.id === client.user.id
        && candidate.content
      )),
    })
  } catch (e) {
    if (e.code === 50001 || e.message === 'Missing Access') return []
    throw e
  }
}

async function searchMemeForDirectQuery({ channel, query }) {
  const excludedFilenames = await recentBotResultFilenames(channel)
  return searchMemeByQuery({
    query,
    excludedFilenames,
    logPayload: {
      channelId: channel?.id || '',
      searchMode: 'suora_hakusana',
      querySource: 'slash_hakusana',
    },
  })
}

async function searchMemeForChannelContext({ channel, excludedMessageId = '' }) {
  if (!channel?.messages?.fetch) return { status: 'no_context' }
  if (!canReadChannelHistory(channel)) return { status: 'missing_access' }

  const fetchLimit = Math.min(
    Math.max(memeFetchLimit, memeContextLimit + (excludedMessageId ? 1 : 0)),
    100,
  )
  let fetchedMessages
  try {
    fetchedMessages = await channel.messages.fetch({ limit: fetchLimit })
  } catch (e) {
    if (e.code === 50001 || e.message === 'Missing Access') {
      return { status: 'missing_access' }
    }
    throw e
  }
  const fetchedMessageList = Array.from(fetchedMessages.values())
  const previousBotResults = fetchedMessageList.filter((candidate) => (
    candidate.author?.id === client.user.id
    && candidate.content
  ))
  const excludedFilenames = mediaFilenamesFromMessages({
    publicBaseUrl,
    messages: previousBotResults,
  })
  const newestBotResultTimestamp = previousBotResults.length > 0
    ? Math.max(...previousBotResults.map((candidate) => candidate.createdTimestamp || 0))
    : 0
  const hasHumanMessagesAfterBotResult = fetchedMessageList.some((candidate) => (
    candidate.createdTimestamp > newestBotResultTimestamp
    && candidate.id !== excludedMessageId
    && !candidate.author?.bot
  ))
  const scopedMessages = hasHumanMessagesAfterBotResult
    ? fetchedMessageList.filter((candidate) => (
      candidate.createdTimestamp > newestBotResultTimestamp
    ))
    : fetchedMessageList
  const contextMessages = scopedMessages
    .filter((candidate) => candidate.id !== excludedMessageId)
    .filter((candidate) => !candidate.author?.bot)
  const queryMessages = [...contextMessages]
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
    .slice(-memeContextLimit)
  const fallbackQuery = buildMemeSearchQuery(queryMessages, {
    limit: memeContextLimit,
    maxLength: memeQueryMaxLength,
  })
  const queryInfo = await buildSearchQueryForMessages({
    messages: queryMessages,
    fallbackQuery,
  })
  const { query } = queryInfo

  if (!query) return { status: 'no_context' }

  const logPayload = {
    channelId: channel.id,
    fetchLimit,
    fetchedMessageCount: fetchedMessageList.length,
    availableContextMessageCount: contextMessages.length,
    usedMessageCount: queryMessages.length,
    excludedFilenames,
    scopedAfterBotResult: hasHumanMessagesAfterBotResult,
    usedMessages: [...queryMessages]
      .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0))
      .map((message) => ({
        id: message.id,
        authorId: message.author?.id || '',
        author: message.author?.username || message.author?.tag || '',
        createdAt: message.createdAt?.toISOString?.() || '',
        content: message.content || '',
      })),
    query,
    querySource: queryInfo.source,
    queryModel: queryInfo.source === 'gemini' ? memeQueryModel : '',
    fallbackQuery,
    generatedQueryRaw: queryInfo.rawText,
    queryExtractionError: queryInfo.error,
  }

  return searchMemeByQuery({
    query,
    excludedFilenames,
    logPayload,
  })
}

async function searchMemeForTargetMessage({ channel, targetMessage }) {
  if (!channel?.messages?.fetch) return { status: 'no_context' }
  if (!canReadChannelHistory(channel)) return { status: 'missing_access' }
  if (!targetMessage) return { status: 'no_context' }

  const fetchLimit = Math.min(Math.max(memeFetchLimit, memeContextLimit), 100)
  let beforeMessages
  try {
    beforeMessages = await channel.messages.fetch({
      before: targetMessage.id,
      limit: Math.max(fetchLimit - 1, 1),
    })
  } catch (e) {
    if (e.code === 50001 || e.message === 'Missing Access') {
      return { status: 'missing_access' }
    }
    throw e
  }

  const fetchedMessageList = [
    targetMessage,
    ...Array.from(beforeMessages.values()),
  ]
  const contextMessages = fetchedMessageList
    .filter((candidate) => !candidate.author?.bot)
  const queryMessages = [...contextMessages]
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
    .slice(-memeContextLimit)
  const fallbackQuery = buildMemeSearchQuery(queryMessages, {
    limit: memeContextLimit,
    maxLength: memeQueryMaxLength,
  })
  const queryInfo = await buildSearchQueryForMessages({
    messages: queryMessages,
    fallbackQuery,
  })
  const { query } = queryInfo

  if (!query) return { status: 'no_context' }

  const excludedFilenames = await recentBotResultFilenames(channel)
  return searchMemeByQuery({
    query,
    excludedFilenames,
    logPayload: {
      channelId: channel.id,
      searchMode: 'viestikonteksti',
      anchorMessageId: targetMessage.id,
      fetchLimit,
      fetchedMessageCount: fetchedMessageList.length,
      availableContextMessageCount: contextMessages.length,
      usedMessageCount: queryMessages.length,
      usedMessages: [...queryMessages]
        .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0))
        .map((message) => ({
          id: message.id,
          authorId: message.author?.id || '',
          author: message.author?.username || message.author?.tag || '',
          createdAt: message.createdAt?.toISOString?.() || '',
          content: message.content || '',
        })),
      querySource: queryInfo.source,
      queryModel: queryInfo.source === 'gemini' ? memeQueryModel : '',
      fallbackQuery,
      generatedQueryRaw: queryInfo.rawText,
      queryExtractionError: queryInfo.error,
    },
  })
}

async function handleMemeSearchResult(interaction, result) {
  if (result.status === 'no_context') {
    await editInteractionTemporarily(interaction, botMessages.memeSearchNoContext)
    return
  }

  if (result.status === 'no_results') {
    await editInteractionTemporarily(interaction, botMessages.memeSearchNoResults)
    return
  }

  if (result.status === 'missing_access') {
    await editInteractionTemporarily(interaction, botMessages.memeSearchMissingAccess)
    return
  }

  await interaction.editReply(result.url)
}

async function handleMemeSearchCommand(message) {
  if (!isMemeSearchCommand(message.content)) return false

  try {
    if (message.channel.sendTyping) await message.channel.sendTyping()

    const result = await searchMemeForChannelContext({
      channel: message.channel,
      excludedMessageId: message.id,
    })

    if (result.status === 'no_context') {
      await replyTemporarily(message, botMessages.memeSearchNoContext)
      return true
    }

    if (result.status === 'no_results') {
      await replyTemporarily(message, botMessages.memeSearchNoResults)
      return true
    }

    if (result.status === 'missing_access') {
      await replyTemporarily(message, botMessages.memeSearchMissingAccess)
      return true
    }

    await message.reply(result.url)
  } catch (e) {
    console.error(`Meemihakukomento epäonnistui: ${e.message}`)
    await replyTemporarily(message, botMessages.memeSearchError)
  }

  return true
}

async function handleMemeSlashCommand(interaction) {
  const isMemeCommand = (
    interaction.isChatInputCommand()
    && isMemeSlashCommand(interaction.commandName, memeSlashCommandName)
  )

  if (!isMemeCommand) {
    return
  }

  const channel = interaction.channel || await client.channels.fetch(interaction.channelId)

  try {
    await interaction.deferReply()
    const directQuery = normalizeSearchQuery(interaction.options.getString(memeSearchOptionName))
    const result = directQuery
      ? await searchMemeForDirectQuery({ channel, query: directQuery })
      : await searchMemeForChannelContext({ channel })

    await handleMemeSearchResult(interaction, result)
  } catch (e) {
    console.error(`Meemislash epäonnistui: ${e.message}`)

    if (interaction.deferred || interaction.replied) {
      await editInteractionTemporarily(interaction, botMessages.memeSearchError)
      return
    }

    await interaction.reply({
      content: botMessages.memeSearchError,
      flags: MessageFlags.Ephemeral,
    })
  }
}

async function handleMemeMessageCommand(interaction) {
  const isMemeCommand = (
    interaction.isMessageContextMenuCommand()
    && interaction.commandName === defaultMemeMessageCommandName
  )

  if (!isMemeCommand) {
    return
  }

  const channel = interaction.channel || await client.channels.fetch(interaction.channelId)

  try {
    await interaction.deferReply()
    const result = await searchMemeForTargetMessage({
      channel,
      targetMessage: interaction.targetMessage,
    })
    await handleMemeSearchResult(interaction, result)
  } catch (e) {
    console.error(`Meemiviestikomento epäonnistui: ${e.message}`)

    if (interaction.deferred || interaction.replied) {
      await editInteractionTemporarily(interaction, botMessages.memeSearchError)
      return
    }

    await interaction.reply({
      content: botMessages.memeSearchError,
      flags: MessageFlags.Ephemeral,
    })
  }
}

client.once('clientReady', async () => {
  // Notice: npm_package_version is only available if the application is launched with npm start
  client.user.setActivity(`v${process.env.npm_package_version}`)

  try {
    await registerMemeCommands()
  } catch (e) {
    console.error(`Meemikomentojen rekisteröinti epäonnistui: ${e.message}`)
  }
})

client.on('interactionCreate', async (interaction) => {
  await handleMemeSlashCommand(interaction)
  await handleMemeMessageCommand(interaction)
})

client.on('messageCreate', async (message) => {
  // Ignore messages by bots (kameli encoding videos)...
  const isAllowedWebhook = message.webhookId && allowedWebhookIds.includes(message.webhookId)
  // ...UNLESS the message comes from an allowlisted webhook.
  if (message.author.bot && !isAllowedWebhook) return

  if (!message.author.bot && await handleMemeSearchCommand(message)) return

  if (message.channel.id !== memeChannelId) return

  // The attachments of messages that are prefixed with '!' are not processed
  if (message.content.startsWith('!')) return

  const contentRows = message.content.split('\n')

  for (const attachment of message.attachments.values()) {
    // Tracked outside the try so the catch can roll back a half-finished upload
    let availableFilename = null
    let writeStream = null
    try {
      const [filename, extension] = utils.separateExtension(attachment.name)

      // Users can only upload pictures, videos and other files with allowed extensions
      if (!utils.isPictureOrVideo(attachment) && !additionalExtensions.includes(extension)) continue

      // no
      if (extension.length > 5) throw new Error(botMessages.invalidExtension)

      // No extra benefits for Nitro users currently!
      // if (attachment.size > 8e6) throw new Error(botMessages.tooBigFile)

      // If the message includes text content, meme name will be taken from it.
      // If a user is uploading multiple files, they can name each of them
      // by separating their names to different rows.
      let memeName = contentRows.shift() || filename

      // Try to automatically shorten the meme name if it's too long
      const maxMemeNameLength = maxFilenameLength - extension.length - 1
      if (memeName.length > maxMemeNameLength) {
        memeName = memeName.slice(0, -(memeName.length - maxMemeNameLength))
      }

      // Sanitize the meme name and find an available file path for it
      availableFilename = await utils.findAvailableFilename(
        uploadDirectory,
        `${utils.alphanum(memeName) || 'nimetön'}.${utils.alphanum(extension)}`,
      )
      const filePath = path.join(uploadDirectory, availableFilename)

      // Download the meme file from Discord's CDN and write it to disk.
      // Wait for the stream to finish so a failed download skips the metadata
      // writes below (via the catch) instead of leaving a broken catalog entry.
      const { data: rawMeme } = await axios({
        method: 'get',
        url: attachment.url,
        responseType: 'stream',
      })
      writeStream = fs.createWriteStream(filePath)
      await new Promise((resolve, reject) => {
        rawMeme.on('error', reject)
        writeStream.on('error', reject)
        writeStream.on('finish', resolve)
        rawMeme.pipe(writeStream)
      })

      // The name of the uploader of the file is shown in Apache directory listing
      await fsp.appendFile(htaccessPath,
        `AddDescription "${utils.alphanum(message.author.username) || 'matti'}" ${availableFilename}\n`)

      // Add item to the index
      await fsp.appendFile(indexPath,
        `"${availableFilename}","${message.author.username}","${utils.currentTimestamp()}","${message.id}"\n`)

      console.log(`Ladattu ${availableFilename}, käyttäjä ${message.author.tag}`)
    } catch (e) {
      // Roll back any partial artifacts so a failed upload leaves nothing behind:
      // close a half-written stream and remove the file plus its metadata entries.
      if (writeStream) writeStream.destroy()
      if (availableFilename) await removeUploads([availableFilename])

      const errorMessage = await message.reply(`${botMessages.uploadError}: ${e.message}`)
      setTimeout(() => errorMessage.delete().catch(() => {}), 30000)
    }
  }
})

client.on('messageDelete', async (message) => {
  const channelId = message.channelId || message.channel?.id
  if (channelId !== memeChannelId) return

  const filenames = await filenamesForMessage(message.id)
  if (filenames.length === 0) return

  await removeUploads(filenames)
  console.log(`Poistettu ${filenames.length} tiedosto(a) poistetulle viestille ${message.id}`)
})

client.login(token)
