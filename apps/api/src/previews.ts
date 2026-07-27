import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import sharp from 'sharp'

import { checksumFile } from '../../../src/search/media.js'
import type { ApiConfig } from './config.ts'

const execFileAsync = promisify(execFile)

interface MediaRow {
  filename: string
  media_type: 'image' | 'video' | 'audio'
  checksum: string
  preview_status: string
  preview_version: number
  dominant_color: string
}

interface ProbeResult {
  width: number
  height: number
  durationMs: number
}

export interface PreviewResult extends ProbeResult {
  checksum: string
  dominantColor: string
}

const run = async (command: string, args: string[], timeout: number) => {
  try {
    return await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout,
    })
  } catch (error) {
    const current = error as Error & { stderr?: string }
    const detail = String(current.stderr || current.message).trim()
    throw new Error(`${path.basename(command)} epäonnistui: ${detail}`)
  }
}

const probeMedia = async (filePath: string, config: ApiConfig): Promise<ProbeResult> => {
  const { stdout } = await run(config.ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    filePath,
  ], config.videoFfmpegTimeoutMs)
  const result = JSON.parse(stdout)
  const video = (result.streams || []).find((stream: { codec_type: string }) => (
    stream.codec_type === 'video'
  ))

  return {
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    durationMs: Math.max(0, Math.round((Number(result.format?.duration) || 0) * 1000)),
  }
}

const colorHex = (color: { r: number, g: number, b: number } | undefined) => {
  if (!color) return '#171717'
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0'))
    .join('')}`
}

const writeImageSizes = async ({
  sourcePath,
  destination,
  config,
}: {
  sourcePath: string
  destination: string
  config: ApiConfig
}) => {
  const image = sharp(sourcePath, {
    animated: false,
    pages: 1,
    limitInputPixels: 100_000_000,
  }).rotate()
  const metadata = await image.metadata()
  const stats = await image.stats()

  await Promise.all(config.previewWidths.map((width: number) => (
    sharp(sourcePath, {
      animated: false,
      pages: 1,
      limitInputPixels: 100_000_000,
    })
      .rotate()
      .resize({
        width,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: config.previewImageQuality,
        effort: 4,
      })
      .toFile(path.join(destination, `${width}.webp`))
  )))

  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    dominantColor: colorHex(stats.dominant),
  }
}

const generateImagePreview = async ({
  filePath,
  destination,
  config,
}: {
  filePath: string
  destination: string
  config: ApiConfig
}) => {
  const image = await writeImageSizes({
    sourcePath: filePath,
    destination,
    config,
  })
  return {
    ...image,
    durationMs: 0,
  }
}

const generateVideoPreview = async ({
  filePath,
  destination,
  config,
}: {
  filePath: string
  destination: string
  config: ApiConfig
}) => {
  const probe = await probeMedia(filePath, config)
  const durationSeconds = probe.durationMs / 1000
  const startSeconds = Math.min(3, Math.max(0, durationSeconds * 0.1))
  const clipSeconds = Math.max(
    0.5,
    Math.min(config.videoPreviewSeconds, durationSeconds - startSeconds),
  )
  const posterPath = path.join(destination, 'poster.jpg')

  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(startSeconds),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease',
    '-q:v', '3',
    posterPath,
  ], config.videoFfmpegTimeoutMs)

  const image = await writeImageSizes({
    sourcePath: posterPath,
    destination,
    config,
  })

  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(startSeconds),
    '-i', filePath,
    '-t', String(clipSeconds),
    '-an',
    '-vf', `fps=${config.videoPreviewFps},scale=${config.videoPreviewWidth}:${config.videoPreviewWidth}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:v', 'libvpx-vp9',
    '-crf', '40',
    '-b:v', '0',
    '-deadline', 'good',
    '-cpu-used', '4',
    '-row-mt', '1',
    '-pix_fmt', 'yuv420p',
    path.join(destination, 'preview.webm'),
  ], config.videoFfmpegTimeoutMs)

  await fsp.rm(posterPath, { force: true })

  return {
    width: probe.width || image.width,
    height: probe.height || image.height,
    durationMs: probe.durationMs,
    dominantColor: image.dominantColor,
  }
}

const generateAudioPreview = async ({
  filePath,
  config,
}: {
  filePath: string
  config: ApiConfig
}) => {
  const probe = await probeMedia(filePath, config)
  return {
    width: 4,
    height: 3,
    durationMs: probe.durationMs,
    dominantColor: '#171717',
  }
}

export const previewDirectory = (config: ApiConfig, checksum: string) => (
  path.join(config.previewRoot, `v${config.previewVersion}`, checksum)
)

export const generatePreview = async ({
  row,
  config,
}: {
  row: MediaRow
  config: ApiConfig
}): Promise<PreviewResult> => {
  const filePath = path.join(config.uploadDirectory, row.filename)
  const checksum = await checksumFile(filePath)
  const destination = previewDirectory(config, checksum)

  if (
    row.checksum === checksum
    && row.preview_status === 'ready'
    && row.preview_version === config.previewVersion
  ) {
    const files = row.media_type === 'video'
      ? ['320.webp', '640.webp', '1280.webp', 'preview.webm']
      : row.media_type === 'image'
        ? ['320.webp', '640.webp', '1280.webp']
        : []
    const allExist = (await Promise.all(files.map(async (filename) => {
      try {
        await fsp.access(path.join(destination, filename))
        return true
      } catch {
        return false
      }
    }))).every(Boolean)

    if (allExist) {
      const dimensions = row.media_type === 'image'
        ? await sharp(filePath, {
          animated: false,
          pages: 1,
          limitInputPixels: 100_000_000,
        }).metadata()
        : await probeMedia(filePath, config)
      return {
        checksum,
        width: Number(dimensions.width) || 0,
        height: Number(dimensions.height) || 0,
        durationMs: 'durationMs' in dimensions ? dimensions.durationMs : 0,
        dominantColor: row.dominant_color || '#171717',
      }
    }
  }

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temporary = await fsp.mkdtemp(`${destination}.tmp-`)

  try {
    const metadata = row.media_type === 'image'
      ? await generateImagePreview({ filePath, destination: temporary, config })
      : row.media_type === 'video'
        ? await generateVideoPreview({ filePath, destination: temporary, config })
        : await generateAudioPreview({ filePath, config })

    if (row.media_type !== 'audio') {
      await fsp.rm(destination, { recursive: true, force: true })
      await fsp.rename(temporary, destination)
    }

    return {
      checksum,
      ...metadata,
    }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true })
  }
}
