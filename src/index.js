/* eslint-disable no-await-in-loop */

import { Client } from 'discord.js'
import dotenv from 'dotenv'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import axios from 'axios'

import * as utils from './utils.js'

const maxFilenameLength = 23
const additionalExtensions = ['mp3', 'wav', 'ogg']

dotenv.config()

const memeChannelId = process.env.MEME_CHANNEL_ID
const token = process.env.DISCORD_BOT_TOKEN
const uploadDirectory = process.env.UPLOAD_DIR || 'public/'
const htaccessPath = process.env.HTACCESS_PATH || 'public/.htaccess'

const client = new Client()

client.on('message', async (message) => {
  if (message.channel.id !== memeChannelId) return

  // The attachments of messages that are prefixed with '#' are not processed
  if (message.content.startsWith('#')) return

  const contentRows = message.content.split('\n')

  for (const attachmentItem of message.attachments) {
    const [, attachment] = attachmentItem

    const [filename, extension] = utils.separateExtension(attachment.name)

    // no
    if (extension.length > 5) return

    // No extra benefits for Nitro users currently!
    if (attachment.size > 8e6) {
      message.react('💾')
      return
    }

    // Users can only upload pictures, videos and other files with allowed extensions
    if (!utils.isPictureOrVideo(attachment) && !additionalExtensions.includes(extension)) return

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
      utils.alphanum(`${memeName}.${extension}`))
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
      `AddDescription "${utils.alphanum(message.author.username)}" ${availableFilename}\n`)
  }
})

client.login(token)