import { Transform } from 'node:stream'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  fileExtension,
  mediaTypeForFilename,
  readableFilename,
} from '../../../src/mediaStore.js'
import type { InternalUploadRequest } from '@kaatis/contracts'
import sharp from 'sharp'
import type { ApiConfig } from './config.ts'

const execFileAsync = promisify(execFile)
const forbiddenUploadExtensions = new Set(['svg'])

interface Store {
  mediaByFilename: (filename: string) => Record<string, unknown> | null
  saveUploadedMedia: (
    media: Record<string, unknown>
  ) => Record<string, unknown> | undefined
}

const sanitizeStem = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9_*+=().-]/g, '-')
  .split('-')
  .filter(Boolean)
  .join('-')

const assertSourceUrl = (value: string, config: ApiConfig) => {
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || !config.allowedSourceHosts.has(url.hostname.toLowerCase())
  ) {
    throw new Error('source_url_not_allowed')
  }
  return url
}

const fetchSource = async (sourceUrl: string, config: ApiConfig) => {
  let url = assertSourceUrl(sourceUrl, config)

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5 * 60 * 1000),
      headers: {
        'user-agent': 'kaatis.party/2',
      },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('source_redirect_missing')
      url = assertSourceUrl(new URL(location, url).toString(), config)
      continue
    }
    if (!response.ok || !response.body) {
      throw new Error(`source_download_failed_${response.status}`)
    }

    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > config.maxUploadBytes) {
      throw new Error('file_too_large')
    }
    return response
  }

  throw new Error('too_many_redirects')
}

const availableFilename = async ({
  requestedName,
  originalFilename,
  uploadDirectory,
  store,
}: {
  requestedName: string
  originalFilename: string
  uploadDirectory: string
  store: Store
}) => {
  const extension = fileExtension(originalFilename)
  if (!extension || extension.length > 5) throw new Error('invalid_extension')
  if (forbiddenUploadExtensions.has(extension)) {
    throw new Error('unsupported_media_type')
  }
  const type = mediaTypeForFilename(`file.${extension}`)
  if (type === 'unknown') throw new Error('unsupported_media_type')

  const originalStem = path.basename(
    originalFilename,
    path.extname(originalFilename),
  )
  const maximumStemLength = 123 - extension.length - 1
  const stem = (
    sanitizeStem(requestedName || originalStem)
    || 'nimetön'
  ).slice(0, maximumStemLength)

  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const filename = suffix === 0
      ? `${stem}.${extension}`
      : `${stem}_${suffix}.${extension}`
    if (store.mediaByFilename(filename)) continue
    try {
      await fsp.access(path.join(uploadDirectory, filename))
    } catch {
      return filename
    }
  }
  throw new Error('filename_space_exhausted')
}

const validateDownloadedMedia = async ({
  filePath,
  filename,
  config,
}: {
  filePath: string
  filename: string
  config: ApiConfig
}) => {
  const mediaType = mediaTypeForFilename(filename)
  if (mediaType === 'image') {
    try {
      const metadata = await sharp(filePath, {
        animated: false,
        pages: 1,
        limitInputPixels: 100_000_000,
      }).metadata()
      if (!metadata.format || !metadata.width || !metadata.height) {
        throw new Error('invalid_media')
      }
    } catch {
      throw new Error('invalid_media')
    }
    return
  }

  let probe
  try {
    const { stdout } = await execFileAsync(config.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type',
      '-of', 'json',
      filePath,
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 60 * 1000,
    })
    probe = JSON.parse(stdout)
  } catch {
    throw new Error('invalid_media')
  }
  const streamTypes = new Set(
    (probe.streams || []).map((stream: { codec_type: string }) => (
      stream.codec_type
    )),
  )
  const valid = mediaType === 'video'
    ? streamTypes.has('video')
    : streamTypes.has('audio')
  if (!valid) throw new Error('invalid_media')
}

export const ingestUpload = async ({
  input,
  config,
  store,
}: {
  input: InternalUploadRequest
  config: ApiConfig
  store: Store
}) => {
  const filename = await availableFilename({
    requestedName: input.requestedName,
    originalFilename: input.originalFilename,
    uploadDirectory: config.uploadDirectory,
    store,
  })
  const incomingDirectory = path.join(config.uploadDirectory, '.incoming')
  await fsp.mkdir(incomingDirectory, { recursive: true })
  await fsp.mkdir(config.uploadDirectory, { recursive: true })
  const temporaryPath = path.join(
    incomingDirectory,
    `${crypto.randomUUID()}.part`,
  )
  const destination = path.join(config.uploadDirectory, filename)
  let moved = false

  try {
    const response = await fetchSource(input.sourceUrl, config)
    let bytes = 0
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > config.maxUploadBytes) {
          callback(new Error('file_too_large'))
          return
        }
        callback(null, chunk)
      },
    })
    const fileHandle = await fsp.open(temporaryPath, 'wx')
    const destinationStream = fileHandle.createWriteStream()
    await pipeline(
      Readable.fromWeb(response.body as never),
      limiter,
      destinationStream,
    )
    if (bytes === 0) throw new Error('empty_file')
    await validateDownloadedMedia({
      filePath: temporaryPath,
      filename,
      config,
    })

    await fsp.rename(temporaryPath, destination)
    moved = true
    const stat = await fsp.stat(destination)
    const row = store.saveUploadedMedia({
      filename,
      title: input.requestedName || readableFilename(filename),
      creator: input.creator,
      modified: input.modified || new Date().toISOString(),
      discordMessageId: input.discordMessageId,
      mediaType: mediaTypeForFilename(filename),
      extension: fileExtension(filename),
      fileSize: stat.size,
      fileMtimeMs: Math.trunc(stat.mtimeMs),
      previewStatus: 'pending',
      previewVersion: 0,
    })
    if (!row) throw new Error('metadata_write_failed')
    return row
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true })
    if (moved) await fsp.rm(destination, { force: true })
    throw error
  }
}
