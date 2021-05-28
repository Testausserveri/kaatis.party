import { Client } from 'discord.js'
import dotenv from 'dotenv'
import fs from 'fs/promises'
import path from 'path'

dotenv.config()

const client = new Client()

// kiitti hegez
const alphanum = (s) => s.normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9_*+=()-]/g, '-')
  .split('-')
  .filter((x) => x !== '')
  .join('-')

const splitFileName = (str) => str.match(/([0-9a-z]+)\.([0-9a-z]+)$/)

client
  .on('ready', console.log('nyt meni kaatisbotti päälle'))

  .on('message', (msg) => {
    if (msg.channel.id !== process.env.MEME_CHANNEL_ID) return

    const attachment = msg.attachments.first()
    if (!attachment || !attachment.width || !attachment.height) return
    if (attachment.size > 8e6) return

    const splitResult = splitFileName(attachment.name)
    if (!splitResult) return
    const [, fileName, fileExtension] = splitResult

    const prettyFileName = `${alphanum(fileName)}.${alphanum(fileExtension)}`
    if (prettyFileName.length > 30) return

    const filePath = path.join(process.env.UPLOAD_DIR, fileName)

    fs.access(filePath)
      .then(() => msg.author.send('Tämän niminen tiedosto on jo lähetetty kaatikseen!'))
      .catch(() => fs.writeFile(prettyFileName, attachment.attachment)
        .then(() => fs.appendFile(process.env.HTACCESS_PATH,
          `AddDescription ${prettyFileName} ${alphanum(msg.author.username)}-${msg.author.discriminator}`)))
  })

client.login(process.env.DISCORD_BOT_TOKEN)
