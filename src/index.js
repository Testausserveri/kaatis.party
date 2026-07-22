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
      if (e.code !== 'ENOENT') console.error(`Could not remove file ${filename}: ${e.message}`)
    }
  }

  // .htaccess lines end with the filename; index rows start with "filename",
  await removeLines(htaccessPath, (line) => set.has(line.split(' ').pop()))
  await removeLines(indexPath, (line) => {
    const match = line.match(/^"([^"]*)",/)
    return match !== null && set.has(match[1])
  })
}

client.on('message', async (message) => {
  if (message.channel.id !== memeChannelId) return

  // The attachments of messages that are prefixed with '!' are not processed
  if (message.content.startsWith('!')) return

  // Ignore messages by bots (kameli encoding videos)
  if (message.author.bot) return

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
      availableFilename = await utils.findAvailableFilename(uploadDirectory,
        (utils.alphanum(memeName) || "nimetön") + "." + utils.alphanum(extension))
      const filePath = path.join(uploadDirectory, availableFilename)

      // Download the meme file from Discord's CDN and write it to disk.
      // Wait for the stream to finish so a failed download skips the metadata
      // writes below (via the catch) instead of leaving a broken catalog entry.
      const { data: rawMeme } = await axios({
        method: 'get',
        url: attachment.attachment,
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
        `AddDescription "${utils.alphanum(message.author.username) || "matti"}" ${availableFilename}\n`)

      // Add item to the index
      await fsp.appendFile(indexPath,
        `"${availableFilename}","${message.author.username}","${utils.currentTimestamp()}","${message.id}"\n`)

      console.log(`Successfully uploaded ${availableFilename} by ${message.author.tag}`)
    } catch (e) {
      // Roll back any partial artifacts so a failed upload leaves nothing behind:
      // close a half-written stream and remove the file plus its metadata entries.
      if (writeStream) writeStream.destroy()
      if (availableFilename) await removeUploads([availableFilename])

      const errorMessage = await message.reply(`${selectedTranslations.uploadError}: ${e.message}`)
      client.setTimeout(() => errorMessage.delete(), 30000)
    }
  }
})

client.on('messageDelete', async (message) => {
  if (message.channel.id !== memeChannelId) return

  const filenames = await filenamesForMessage(message.id)
  if (filenames.length === 0) return

  await removeUploads(filenames)
  console.log(`Removed ${filenames.length} file(s) for deleted message ${message.id}`)
})

client.login(token)
