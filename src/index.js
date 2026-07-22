/* eslint-disable no-await-in-loop */

import { Client } from 'discord.js'
import translatedMessages from './i18n.js'
import dotenv from 'dotenv'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import axios from 'axios'

import * as utils from './utils.js'

const maxFilenameLength = 123
const additionalExtensions = ['mp3', 'wav', 'ogg']

dotenv.config()

const memeChannelId = process.env.MEME_CHANNEL_ID
const token = process.env.DISCORD_BOT_TOKEN
const uploadDirectory = process.env.UPLOAD_DIR || 'public/'
const htaccessPath = process.env.HTACCESS_PATH || 'public/.htaccess'
const indexPath = process.env.INDEX_PATH || 'public/indeksi.csv'
const selectedLanguage = process.env.LANGUAGE || 'english'

const selectedTranslations = translatedMessages[selectedLanguage]

// 'MESSAGE'/'CHANNEL' partials make messageDelete fire for messages that
// aren't in the cache (e.g. anything uploaded before the last bot restart).
const client = new Client({ partials: ['MESSAGE', 'CHANNEL'] })

client.on('ready', async () => {
  // Notice: npm_package_version is only available if the application is launched with npm start
  client.user.setActivity(`v${process.env.npm_package_version}`)
})

client.on('message', async (message) => {
  if (message.channel.id !== memeChannelId) return

  // The attachments of messages that are prefixed with '!' are not processed
  if (message.content.startsWith('!')) return

  // Ignore messages by bots (kameli encoding videos)
  if (message.author.bot) return

  const contentRows = message.content.split('\n')

  for (const attachment of message.attachments.values()) {
    try {
      const [filename, extension] = utils.separateExtension(attachment.name)

      // Users can only upload pictures, videos and other files with allowed extensions
      if (!utils.isPictureOrVideo(attachment) && !additionalExtensions.includes(extension)) continue

      // no
      if (extension.length > 5) throw new Error(selectedTranslations.invalidExtension)

      // No extra benefits for Nitro users currently!
      // if (attachment.size > 8e6) throw new Error(selectedTranslations.tooBigFile)

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
      const availableFilename = await utils.findAvailableFilename(uploadDirectory,
        (utils.alphanum(memeName) || "nimetön") + "." + utils.alphanum(extension))
      const filePath = path.join(uploadDirectory, availableFilename)

      // Download the meme file from Discord's CDN and write it to disk
      const { data: rawMeme } = await axios({
        method: 'get',
        url: attachment.attachment,
        responseType: 'stream',
      })
      rawMeme.pipe(fs.createWriteStream(filePath))

      // The name of the uploader of the file is shown in Apache directory listing
      fsp.appendFile(htaccessPath,
        `AddDescription "${utils.alphanum(message.author.username) || "matti"}" ${availableFilename}\n`)

      // Add item to the index
      fsp.appendFile(indexPath,
        `"${availableFilename}","${message.author.username}","${utils.currentTimestamp()}","${message.id}"\n`)

      console.log(`Successfully uploaded ${availableFilename} by ${message.author.tag}`)
    } catch (e) {
      const errorMessage = await message.reply(`${selectedTranslations.uploadError}: ${e.message}`)
      client.setTimeout(() => errorMessage.delete(), 30000)
    }
  }
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

client.on('messageDelete', async (message) => {
  if (message.channel.id !== memeChannelId) return

  const filenames = new Set(await filenamesForMessage(message.id))
  if (filenames.size === 0) return

  // Delete the files from disk
  for (const filename of filenames) {
    try {
      await fsp.unlink(path.join(uploadDirectory, filename))
      console.log(`Deleted ${filename} (message ${message.id} deleted)`)
    } catch (e) {
      console.error(`Failed to delete ${filename}: ${e.message}`)
    }
  }

  // Scrub their metadata regardless of whether the files were still on disk.
  // .htaccess lines end with the filename; index rows start with "filename",
  await removeLines(htaccessPath, (line) => filenames.has(line.split(' ').pop()))
  await removeLines(indexPath, (line) => {
    const match = line.match(/^"([^"]*)",/)
    return match !== null && filenames.has(match[1])
  })
})

client.login(token)
