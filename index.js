import { Client } from 'discord.js'
import dotenv from 'dotenv'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import axios from 'axios'

dotenv.config()

const client = new Client()

// kiitti hegez
const alphanum = (s) => s.normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9_*+=()-\.]/g, '-')
  .split('-')
  .filter((x) => x !== '')
  .join('-')

client
  .on('ready', () => console.log('nyt meni kaatisbotti päälle'))

  .on('message', (msg) => {
    if (msg.channel.id !== process.env.MEME_CHANNEL_ID) return

    const attachment = msg.attachments.first()
    if (!attachment || !attachment.width || !attachment.height) return
    if (attachment.size > 8e6) return

    const prettyFileName = `${alphanum(attachment.name)}`
    if (prettyFileName.length > 30) return

    const filePath = path.join(process.env.UPLOAD_DIR, prettyFileName)

    fsp.access(filePath)
      .then(() => msg.author.send('Tämän niminen tiedosto on jo lähetetty kaatikseen!'))
      .catch(() => axios({
        method: "get",
        url: attachment.attachment,
        responseType: "stream"
      })
        .then((response) => response.data.pipe(fs.createWriteStream(filePath)))
        .then(() => fsp.appendFile(process.env.HTACCESS_PATH,
          `AddDescription ${prettyFileName} ${alphanum(msg.author.username)}-${msg.author.discriminator}`)))
  })

client.login(process.env.DISCORD_BOT_TOKEN)
