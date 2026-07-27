import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getSearchConfig } from '../../../src/search/config.js'

const appRoot = fileURLToPath(new URL('../../../', import.meta.url))
const appPath = (value: string) => (
  path.isAbsolute(value) ? value : path.resolve(appRoot, value)
)

const positiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const getApiConfig = (env = process.env) => {
  const search = getSearchConfig(env)

  return {
    ...search,
    mediaDbPath: appPath(search.mediaDbPath),
    uploadDirectory: appPath(search.uploadDirectory),
    videoBatchStatePath: appPath(search.videoBatchStatePath),
    apiPort: positiveNumber(env.API_PORT, 3000),
    apiHost: env.API_HOST || '0.0.0.0',
    internalToken: env.SEARCH_INTERNAL_TOKEN || '',
    previewRoot: appPath(env.PREVIEW_ROOT || 'data/thumbs'),
    previewVersion: positiveNumber(env.PREVIEW_VERSION, 1),
    previewWidths: [320, 640, 1280],
    previewImageQuality: positiveNumber(env.PREVIEW_IMAGE_QUALITY, 80),
    videoPreviewWidth: positiveNumber(env.VIDEO_PREVIEW_WIDTH, 480),
    videoPreviewSeconds: positiveNumber(env.VIDEO_PREVIEW_SECONDS, 4),
    videoPreviewFps: positiveNumber(env.VIDEO_PREVIEW_FPS, 12),
    maxUploadBytes: positiveNumber(env.MAX_UPLOAD_BYTES, 256 * 1024 * 1024),
    uploadTempDirectory: env.UPLOAD_TEMP_DIR || path.join(os.tmpdir(), 'kaatis-upload'),
    allowedSourceHosts: new Set(
      (env.UPLOAD_SOURCE_HOSTS || 'cdn.discordapp.com,media.discordapp.net')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
    jobPollMs: positiveNumber(env.JOB_POLL_MS, 750),
    jobWorkers: positiveNumber(env.JOB_WORKERS, 2),
    publicBaseUrl: env.PUBLIC_BASE_URL || '/',
  }
}

export type ApiConfig = ReturnType<typeof getApiConfig>
