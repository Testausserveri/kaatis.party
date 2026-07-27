import { execFile } from 'child_process'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const runMediaCommand = async (command, args, timeoutMs) => {
  try {
    return await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    })
  } catch (error) {
    const details = String(error.stderr || error.message || '').trim()
    throw new Error(`${path.basename(command)} epäonnistui: ${details}`)
  }
}

export const audioSegmentsForDuration = (
  durationSeconds,
  {
    maxDurationSeconds = 300,
    segmentSeconds = 155,
    overlapSeconds = 5,
  } = {},
) => {
  const cappedDuration = Math.max(0, Math.min(durationSeconds, maxDurationSeconds))
  if (cappedDuration === 0) return []
  if (cappedDuration <= 180) {
    return [{ index: 0, startSeconds: 0, endSeconds: cappedDuration }]
  }

  const stride = Math.max(1, segmentSeconds - overlapSeconds)
  const segments = []
  for (let start = 0; start < cappedDuration; start += stride) {
    const end = Math.min(cappedDuration, start + segmentSeconds)
    segments.push({
      index: segments.length,
      startSeconds: start,
      endSeconds: end,
    })
    if (end >= cappedDuration) break
  }
  return segments
}

export const probeVideo = async (filePath, config) => {
  const { stdout } = await runMediaCommand(config.ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json',
    filePath,
  ], config.videoFfmpegTimeoutMs)
  const result = JSON.parse(stdout)
  const durationSeconds = Number(result.format?.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Videon kestoa ei voitu lukea')
  }

  return {
    durationSeconds,
    hasAudio: (result.streams || []).some((stream) => stream.codec_type === 'audio'),
  }
}

const extractStoryboard = async ({
  filePath,
  outputDirectory,
  indexedDurationSeconds,
  config,
}) => {
  const outputPattern = path.join(outputDirectory, 'storyboard-%02d.jpg')
  const fps = config.videoStoryboardFrames / indexedDurationSeconds
  await runMediaCommand(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', filePath,
    '-t', String(indexedDurationSeconds),
    '-vf', `fps=${fps},scale=${config.videoFrameMaxWidth}:-2:force_original_aspect_ratio=decrease`,
    '-frames:v', String(config.videoStoryboardFrames),
    '-q:v', String(config.videoFrameJpegQuality),
    outputPattern,
  ], config.videoFfmpegTimeoutMs)

  const filenames = (await fsp.readdir(outputDirectory))
    .filter((filename) => filename.startsWith('storyboard-') && filename.endsWith('.jpg'))
    .sort()
    .slice(0, config.videoStoryboardFrames)
  if (filenames.length === 0) throw new Error('Videosta ei saatu storyboard-frameja')

  return Promise.all(filenames.map(async (filename) => ({
    data: await fsp.readFile(path.join(outputDirectory, filename)),
    mimeType: 'image/jpeg',
  })))
}

const extractAudio = async ({
  filePath,
  outputDirectory,
  durationSeconds,
  config,
}) => {
  const segments = audioSegmentsForDuration(durationSeconds, {
    maxDurationSeconds: config.videoMaxDurationSeconds,
    segmentSeconds: config.videoAudioSegmentSeconds,
    overlapSeconds: config.videoAudioOverlapSeconds,
  })
  const results = []

  for (const segment of segments) {
    const outputPath = path.join(outputDirectory, `audio-${segment.index}.mp3`)
    await runMediaCommand(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(segment.startSeconds),
      '-t', String(segment.endSeconds - segment.startSeconds),
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libmp3lame',
      '-b:a', `${config.videoAudioBitrateKbps}k`,
      outputPath,
    ], config.videoFfmpegTimeoutMs)

    results.push({
      ...segment,
      data: await fsp.readFile(outputPath),
      mimeType: 'audio/mpeg',
    })
  }

  return results
}

export const prepareVideoForEmbedding = async (media, config) => {
  const temporaryDirectory = await fsp.mkdtemp(path.join(
    config.videoTempDirectory || os.tmpdir(),
    'kaatis-video-',
  ))

  try {
    const probe = await probeVideo(media.filePath, config)
    const indexedDurationSeconds = Math.min(
      probe.durationSeconds,
      config.videoMaxDurationSeconds,
    )
    const storyboard = await extractStoryboard({
      filePath: media.filePath,
      outputDirectory: temporaryDirectory,
      indexedDurationSeconds,
      config,
    })
    const audio = probe.hasAudio
      ? await extractAudio({
        filePath: media.filePath,
        outputDirectory: temporaryDirectory,
        durationSeconds: probe.durationSeconds,
        config,
      })
      : []

    return {
      durationSeconds: probe.durationSeconds,
      indexedDurationSeconds,
      truncated: probe.durationSeconds > indexedDurationSeconds,
      storyboard,
      audio,
      cleanup: () => fsp.rm(temporaryDirectory, { recursive: true, force: true }),
    }
  } catch (error) {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}
