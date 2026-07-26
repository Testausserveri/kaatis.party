import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { parse } from 'csv-parse/sync'
import sharp from 'sharp'

export const imageMimeByExtension = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['svg', 'image/svg+xml'],
  ['tiff', 'image/tiff'],
  ['tif', 'image/tiff'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
])

const geminiImageMimes = new Set(['image/jpeg', 'image/png'])

export const fileExtension = (filename) => path.extname(filename).slice(1).toLowerCase()

export const isImageFilename = (filename) => imageMimeByExtension.has(fileExtension(filename))

export const safeMediaFilename = (filename) => {
  const normalized = path.posix.normalize(String(filename || '').replace(/\\/g, '/'))
  if (
    !normalized
    || normalized === '.'
    || normalized.includes('/')
    || normalized.startsWith('..')
  ) {
    return ''
  }

  return normalized
}

export const readableFilename = (filename) => {
  const extension = path.extname(filename)
  const stem = extension ? filename.slice(0, -extension.length) : filename
  const keywords = stem.match(/([a-zA-Z0-9]+)/g) || []
  const name = keywords.length > 0 ? keywords.join(' ') : stem

  return {
    name,
    keywords: keywords
      .map((keyword) => keyword.toLowerCase())
      .filter((keyword, index) => keyword.length > 1 && keywords.indexOf(keyword) === index),
  }
}

export const parseMediaIndex = (csvText) => parse(csvText, {
  relax_column_count: true,
  relax_quotes: true,
  skip_empty_lines: true,
}).map((row) => ({
  filename: row[0] || '',
  creator: row[1] || '',
  modified: row[2] || '',
  discordMessageId: row[3] || '',
})).filter((row) => row.filename)

export const pointIdForFilename = (filename) => {
  const bytes = Buffer.from(crypto.createHash('sha256').update(filename).digest('hex').slice(0, 32), 'hex')
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const hashText = (text) => crypto.createHash('sha256').update(text).digest('hex')

export const checksumFile = (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  stream.on('error', reject)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('end', () => resolve(hash.digest('hex')))
})

export const buildDocumentText = (media) => {
  const title = media.name || media.filename
  const creator = media.creator || ''
  const modified = media.modified || ''
  return [
    `title: ${title}`,
    `filename: ${media.filename}`,
    `creator: ${creator}`,
    `uploaded_at: ${modified}`,
  ].join('\n')
}

export const mediaPayload = ({
  media,
  checksum,
  sourceTextHash,
  config,
  convertedForEmbedding,
}) => ({
  filename: media.filename,
  url: media.url,
  name: media.name,
  creator: media.creator,
  modified: media.modified,
  discordMessageId: media.discordMessageId,
  mediaType: 'image',
  extension: media.extension,
  checksum,
  sourceTextHash,
  embeddingModel: config.embeddingModel,
  embeddingDimensions: config.embeddingDimensions,
  embeddingInputVersion: config.embeddingInputVersion,
  fileSize: media.fileSize,
  fileMtimeMs: media.fileMtimeMs,
  convertedForEmbedding,
  indexedAt: new Date().toISOString(),
})

export const payloadMatches = ({
  payload,
  checksum,
  sourceTextHash,
  config,
}) => payload
  && payload.checksum === checksum
  && payload.sourceTextHash === sourceTextHash
  && payload.embeddingModel === config.embeddingModel
  && Number(payload.embeddingDimensions) === config.embeddingDimensions
  && payload.embeddingInputVersion === config.embeddingInputVersion

const mediaFromFile = async ({ config, filename, row }) => {
  const filePath = path.join(config.uploadDirectory, filename)
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }

  if (!stat.isFile() || stat.size === 0) return null

  const { name, keywords } = readableFilename(filename)
  const extension = fileExtension(filename)
  return {
    ...row,
    filename,
    id: pointIdForFilename(filename),
    filePath,
    extension,
    mimeType: imageMimeByExtension.get(extension),
    name,
    keywords,
    url: `${config.publicBaseUrl}${filename}`,
    modified: row.modified || new Date(stat.mtimeMs).toISOString(),
    fileSize: stat.size,
    fileMtimeMs: Math.trunc(stat.mtimeMs),
  }
}

export const readIndexedMediaFile = async ({ config, filename }) => {
  const safeFilename = safeMediaFilename(filename)
  if (!safeFilename || !isImageFilename(safeFilename)) return null

  let rows = []
  try {
    rows = parseMediaIndex(await fsp.readFile(config.indexPath, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }

  const row = [...rows].reverse().find((candidate) => candidate.filename === safeFilename) || {
    filename: safeFilename,
    creator: '',
    modified: '',
    discordMessageId: '',
  }

  return mediaFromFile({
    config,
    filename: safeFilename,
    row,
  })
}

export const readIndexedMedia = async (config) => {
  const csvText = await fsp.readFile(config.indexPath, 'utf8')
  const rows = parseMediaIndex(csvText)
  const metadataByFilename = new Map()

  rows.forEach((row) => {
    if (isImageFilename(row.filename)) metadataByFilename.set(row.filename, row)
  })

  const media = []
  const entries = await fsp.readdir(config.uploadDirectory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !isImageFilename(entry.name)) continue

    const row = metadataByFilename.get(entry.name) || {
      filename: entry.name,
      creator: '',
      modified: '',
      discordMessageId: '',
    }
    const item = await mediaFromFile({
      config,
      filename: entry.name,
      row,
    })
    if (item) media.push(item)
  }

  return media.sort((a, b) => new Date(b.modified) - new Date(a.modified))
}

export const prepareImageForEmbedding = async (media, config) => {
  const shouldUseOriginal = geminiImageMimes.has(media.mimeType)
    && media.fileSize <= config.convertImageBytes

  if (shouldUseOriginal) {
    return {
      data: await fsp.readFile(media.filePath),
      mimeType: media.mimeType,
      converted: false,
    }
  }

  const data = await sharp(media.filePath, { animated: false, pages: 1 })
    .rotate()
    .resize({
      width: config.imageMaxDimension,
      height: config.imageMaxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: config.imageJpegQuality })
    .toBuffer()

  return {
    data,
    mimeType: 'image/jpeg',
    converted: true,
  }
}
