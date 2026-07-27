import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js'

import {
  absoluteMediaUrl,
  buildMemeSearchQuery,
  defaultMemeSlashCommandName,
  isMemeSlashCommand,
  isMemeSearchCommand,
  legacyMemeMessageCommandNames,
  legacyMemeSlashCommandNames,
  mediaFilenamesFromMessages,
  memeSearchOptionName,
  memeSlashCommandDefinition,
  nonNegativeNumber,
  positiveInteger,
  selectMemeSearchResult,
} from '../../../src/memeCommand.js'
import {
  createGeminiMemeQueryClient,
  defaultMemeQueryModel,
  generateMemeSearchQuery,
} from '../../../src/memeQuery.js'

const token = process.env.DISCORD_BOT_TOKEN || ''
const memeChannelId = process.env.MEME_CHANNEL_ID || ''
const apiUrl = process.env.KAATIS_API_URL || 'http://api:3000'
const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://kaatis.party'
const internalToken = process.env.SEARCH_INTERNAL_TOKEN || ''
const discordGuildId = process.env.DISCORD_GUILD_ID || ''
const registerSlashCommands = process.env.DISCORD_REGISTER_SLASH_COMMANDS !== 'false'
const memeContextLimit = positiveInteger(process.env.MEME_CONTEXT_LIMIT, 10)
const memeFetchLimit = positiveInteger(process.env.MEME_FETCH_LIMIT, 12)
const memeQueryMaxLength = positiveInteger(process.env.MEME_QUERY_MAX_LENGTH, 480)
const memeSearchLimit = positiveInteger(process.env.MEME_SEARCH_LIMIT, 6)
const memeRandomPoolLimit = positiveInteger(process.env.MEME_RANDOM_POOL_LIMIT, 4)
const memeRandomScoreDelta = nonNegativeNumber(
  process.env.MEME_RANDOM_SCORE_DELTA,
  0.035,
)
const memeSearchLogContext = process.env.MEME_SEARCH_LOG_CONTEXT !== 'false'
const memeQueryModel = process.env.GEMINI_QUERY_MODEL || defaultMemeQueryModel
const allowedWebhookIds = new Set(
  (process.env.ALLOWED_WEBHOOK_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
)

const messages = {
  uploadError: 'Tiedostoa ei voitu lähettää kaatikseen',
  noContext: 'Tarvitsen pari viimeaikaista viestiä ennen kuin osaan valita meemin',
  noResults: 'En löytänyt tähän sopivaa meemiä tällä kertaa',
  missingAccess: 'En pysty lukemaan tämän kanavan viestihistoriaa. Anna botille Näytä kanava ja Lue viestihistoria oikeudet.',
  searchError: 'En pystynyt hakemaan meemejä juuri nyt',
}

const uploadErrorText = (code: string) => ({
  empty_file: 'tiedosto oli tyhjä',
  file_too_large: 'tiedosto on liian suuri',
  invalid_extension: 'tiedoston pääte ei kelpaa',
  invalid_media: 'tiedoston sisältö ei kelpaa',
  source_url_not_allowed: 'tiedoston lähde ei kelpaa',
  unsupported_media_type: 'tiedostomuotoa ei tueta',
}[code] || 'palvelu ei juuri nyt vastaa')

if (!token) throw new Error('DISCORD_BOT_TOKEN puuttuu')
if (!internalToken) throw new Error('SEARCH_INTERNAL_TOKEN puuttuu')

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
})

let queryAi: ReturnType<typeof createGeminiMemeQueryClient> | undefined

const internalHeaders = {
  'content-type': 'application/json',
  'x-kaatis-internal-token': internalToken,
}

const apiRequest = async <T>(
  pathname: string,
  init: RequestInit = {},
): Promise<T> => {
  const response = await fetch(new URL(pathname, apiUrl), {
    ...init,
    signal: AbortSignal.timeout(5 * 60 * 1000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(String(body.error || `API vastasi ${response.status}`))
  }
  return body as T
}

const editTemporarily = async (
  interaction: ChatInputCommandInteraction,
  text: string,
) => {
  await interaction.editReply(text)
  setTimeout(() => interaction.deleteReply().catch(() => {}), 30000)
}

const replyTemporarily = async (message: Message, text: string) => {
  const reply = await message.reply(text)
  setTimeout(() => reply.delete().catch(() => {}), 30000)
}

const canReadHistory = (channel: any) => {
  const permissions = channel?.permissionsFor?.(client.user)
  if (!permissions) return true
  return permissions.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ])
}

const logSearch = (payload: Record<string, unknown>) => {
  if (!memeSearchLogContext) return
  console.log(`Meemihaku\n${JSON.stringify({
    event: 'meemihaku',
    timestamp: new Date().toISOString(),
    ...payload,
  }, null, 2)}`)
}

const serializeResult = (result: any) => ({
  filename: result?.filename || '',
  url: result?.url || '',
  score: result?.score ?? null,
})

const searchByQuery = async ({
  query,
  excludedFilenames = [],
  logPayload = {},
}: {
  query: string
  excludedFilenames?: string[]
  logPayload?: Record<string, unknown>
}) => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return { status: 'no_context' as const }
  const parameters = new URLSearchParams({
    q: normalized,
    limit: String(memeSearchLimit),
  })
  if (excludedFilenames.length > 0) {
    parameters.set('exclude', excludedFilenames.join(','))
  }

  const data = await apiRequest<{ results: any[] }>(
    `/api/search?${parameters.toString()}`,
    {
      headers: {
        'x-kaatis-internal-token': internalToken,
      },
    },
  )
  const candidates = data.results || []
  const {
    result,
    pool,
    selectedIndex,
  } = selectMemeSearchResult(candidates, {
    scoreDelta: memeRandomScoreDelta,
    maxPoolSize: memeRandomPoolLimit,
  })
  if (!result?.url && !result?.filename) {
    return { status: 'no_results' as const }
  }

  logSearch({
    ...logPayload,
    query: normalized,
    excludedFilenames,
    candidateResults: candidates.map(serializeResult),
    selectionPool: pool.map(serializeResult),
    selectedIndex,
    result: serializeResult(result),
  })
  return {
    status: 'found' as const,
    url: absoluteMediaUrl({
      publicBaseUrl,
      mediaUrl: result.url || `/${result.filename}`,
    }),
  }
}

const recentResultFilenames = async (channel: any) => {
  if (!channel?.messages?.fetch) return []
  try {
    const fetched = await channel.messages.fetch({ limit: memeFetchLimit })
    return mediaFilenamesFromMessages({
      publicBaseUrl,
      messages: Array.from(fetched.values()).filter((message: any) => (
        message.author?.id === client.user?.id && message.content
      )),
    })
  } catch (error) {
    const current = error as Error & { code?: number }
    if (current.code === 50001 || current.message === 'Missing Access') return []
    throw error
  }
}

const generatedContextQuery = async (queryMessages: any[], fallbackQuery: string) => {
  try {
    if (!queryAi) {
      queryAi = createGeminiMemeQueryClient({
        apiKey: process.env.GEMINI_API_KEY,
      })
    }
    return await generateMemeSearchQuery({
      ai: queryAi,
      model: memeQueryModel,
      messages: queryMessages,
      fallbackQuery,
      limit: memeContextLimit,
      maxLength: Math.min(memeQueryMaxLength, 160),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Gemini hakukyselyn muodostus epäonnistui: ${message}`)
    return {
      query: fallbackQuery,
      source: 'fallback',
      rawText: '',
      error: message,
    }
  }
}

const searchFromContext = async ({
  channel,
  excludedMessageId = '',
}: {
  channel: any
  excludedMessageId?: string
}) => {
  if (!channel?.messages?.fetch) return { status: 'no_context' as const }
  if (!canReadHistory(channel)) return { status: 'missing_access' as const }

  const fetchLimit = Math.min(
    Math.max(memeFetchLimit, memeContextLimit + (excludedMessageId ? 1 : 0)),
    100,
  )
  let fetched
  try {
    fetched = await channel.messages.fetch({ limit: fetchLimit })
  } catch (error) {
    const current = error as Error & { code?: number }
    if (current.code === 50001 || current.message === 'Missing Access') {
      return { status: 'missing_access' as const }
    }
    throw error
  }

  const all = Array.from(fetched.values()) as any[]
  const previousResults = all.filter((message) => (
    message.author?.id === client.user?.id && message.content
  ))
  const excludedFilenames = mediaFilenamesFromMessages({
    publicBaseUrl,
    messages: previousResults,
  })
  const newestResultAt = previousResults.length > 0
    ? Math.max(...previousResults.map((message) => message.createdTimestamp || 0))
    : 0
  const hasNewContext = all.some((message) => (
    message.createdTimestamp > newestResultAt
    && message.id !== excludedMessageId
    && !message.author?.bot
  ))
  const context = (hasNewContext
    ? all.filter((message) => message.createdTimestamp > newestResultAt)
    : all)
    .filter((message) => message.id !== excludedMessageId)
    .filter((message) => !message.author?.bot)
  const used = [...context]
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
    .slice(-memeContextLimit)
  const fallbackQuery = buildMemeSearchQuery(used, {
    limit: memeContextLimit,
    maxLength: memeQueryMaxLength,
  })
  const queryInfo = await generatedContextQuery(used, fallbackQuery)
  if (!queryInfo.query) return { status: 'no_context' as const }

  return searchByQuery({
    query: queryInfo.query,
    excludedFilenames,
    logPayload: {
      channelId: channel.id,
      fetchedMessageCount: all.length,
      usedMessageCount: used.length,
      scopedAfterBotResult: hasNewContext,
      usedMessages: [...used].reverse().map((message) => ({
        id: message.id,
        author: message.author?.username || '',
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

const sendSearchResult = async (
  interaction: ChatInputCommandInteraction,
  result: Awaited<ReturnType<typeof searchFromContext>>,
) => {
  if (result.status === 'no_context') {
    await editTemporarily(interaction, messages.noContext)
    return
  }
  if (result.status === 'no_results') {
    await editTemporarily(interaction, messages.noResults)
    return
  }
  if (result.status === 'missing_access') {
    await editTemporarily(interaction, messages.missingAccess)
    return
  }
  await interaction.editReply(result.url)
}

const handleSlashCommand = async (interaction: ChatInputCommandInteraction) => {
  if (!isMemeSlashCommand(
    interaction.commandName,
    defaultMemeSlashCommandName,
  )) return

  try {
    await interaction.deferReply()
    const channel = interaction.channel
      || await client.channels.fetch(interaction.channelId)
    const directQuery = String(
      interaction.options.getString(memeSearchOptionName) || '',
    ).trim()
    const result = directQuery
      ? await searchByQuery({
        query: directQuery,
        excludedFilenames: await recentResultFilenames(channel),
        logPayload: {
          channelId: channel?.id || '',
          searchMode: 'suora_hakusana',
          querySource: 'slash_hakusana',
        },
      })
      : await searchFromContext({ channel })
    await sendSearchResult(interaction, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Kaatiskomento epäonnistui: ${message}`)
    if (interaction.deferred || interaction.replied) {
      await editTemporarily(interaction, messages.searchError)
      return
    }
    await interaction.reply({
      content: messages.searchError,
      flags: MessageFlags.Ephemeral,
    })
  }
}

const handleTextCommand = async (message: Message) => {
  if (!isMemeSearchCommand(message.content)) return false
  try {
    if ('sendTyping' in message.channel) await message.channel.sendTyping()
    const result = await searchFromContext({
      channel: message.channel,
      excludedMessageId: message.id,
    })
    if (result.status === 'no_context') {
      await replyTemporarily(message, messages.noContext)
    } else if (result.status === 'no_results') {
      await replyTemporarily(message, messages.noResults)
    } else if (result.status === 'missing_access') {
      await replyTemporarily(message, messages.missingAccess)
    } else {
      await message.reply(result.url)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`Meemihakukomento epäonnistui: ${detail}`)
    await replyTemporarily(message, messages.searchError)
  }
  return true
}

const registerCommands = async () => {
  if (!registerSlashCommands) return
  const applicationId = client.application?.id || client.user?.id
  if (!applicationId) throw new Error('Discord sovellustunnus puuttuu')
  const commandChannel = await client.channels.fetch(memeChannelId) as any
  const guildId = discordGuildId || String(commandChannel?.guildId || '')
  const rest = new REST({ version: '10' }).setToken(token)
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId)
  const current = await rest.get(route) as any[]
  const desired = memeSlashCommandDefinition(defaultMemeSlashCommandName)
  const existing = current.find((command) => (
    command.name === desired.name && command.type === desired.type
  ))
  if (existing) {
    const commandRoute = guildId
      ? Routes.applicationGuildCommand(applicationId, guildId, existing.id)
      : Routes.applicationCommand(applicationId, existing.id)
    await rest.patch(commandRoute, { body: desired })
  } else {
    await rest.post(route, { body: desired })
  }

  const cleanupScopes = guildId ? [guildId, ''] : ['']
  for (const cleanupGuildId of cleanupScopes) {
    const cleanupRoute = cleanupGuildId
      ? Routes.applicationGuildCommands(applicationId, cleanupGuildId)
      : Routes.applicationCommands(applicationId)
    const cleanupCommands = cleanupGuildId === guildId
      ? current
      : await rest.get(cleanupRoute) as any[]

    for (const command of cleanupCommands) {
      const removeSlash = (
        command.type === 1
        && legacyMemeSlashCommandNames.includes(command.name)
      )
      const removeMessage = (
        command.type === 3
        && legacyMemeMessageCommandNames.includes(command.name)
      )
      if (!removeSlash && !removeMessage) continue
      const commandRoute = cleanupGuildId
        ? Routes.applicationGuildCommand(
          applicationId,
          cleanupGuildId,
          command.id,
        )
        : Routes.applicationCommand(applicationId, command.id)
      await rest.delete(commandRoute)
    }
  }

  console.log(`Kaatiskomento päivitetty ${guildId ? `guildiin ${guildId}` : 'globaalisti'}`)
}

client.once('clientReady', async () => {
  client.user!.setActivity(`v${process.env.npm_package_version || '2.0.0'}`)
  try {
    await registerCommands()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Kaatiskomennon rekisteröinti epäonnistui: ${message}`)
  }
})

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) await handleSlashCommand(interaction)
})

client.on('messageCreate', async (message) => {
  const allowedWebhook = (
    message.webhookId
    && allowedWebhookIds.has(message.webhookId)
  )
  if (message.author.bot && !allowedWebhook) return
  if (!message.author.bot && await handleTextCommand(message)) return
  if (message.channel.id !== memeChannelId) return
  if (message.content.startsWith('!')) return

  const names = message.content.split('\n')
  for (const attachment of message.attachments.values()) {
    try {
      const originalStem = attachment.name.replace(/\.[^.]+$/, '')
      const result = await apiRequest<{
        media: { filename: string }
      }>('/internal/media', {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({
          sourceUrl: attachment.url,
          originalFilename: attachment.name,
          requestedName: names.shift() || originalStem,
          creator: message.author.username,
          modified: message.createdAt.toISOString(),
          discordMessageId: message.id,
        }),
      })
      console.log(`Ladattu ${result.media.filename}, käyttäjä ${message.author.tag}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`Lataus epäonnistui: ${detail}`)
      await replyTemporarily(
        message,
        `${messages.uploadError}: ${uploadErrorText(detail)}`,
      )
    }
  }
})

client.on('messageDelete', async (message) => {
  const channelId = message.channelId || message.channel?.id
  if (channelId !== memeChannelId) return
  try {
    const result = await apiRequest<{ deleted: number }>(
      `/internal/media/by-message/${message.id}`,
      {
        method: 'DELETE',
        headers: internalHeaders,
      },
    )
    if (result.deleted > 0) {
      console.log(`Poistettu ${result.deleted} tiedostoa viestille ${message.id}`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`Viestin medioiden poisto epäonnistui: ${detail}`)
  }
})

await client.login(token)
