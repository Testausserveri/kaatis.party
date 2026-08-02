import fsp from 'node:fs/promises'
import path from 'node:path'

import { parse } from 'csv-parse/sync'
import dotenv from 'dotenv'

import {
  createMediaStore,
  ensureMediaStoreDirectory,
  fileExtension,
  mediaTypeForFilename,
  readableFilename,
} from './mediaStore.js'
import { getSearchConfig } from './search/config.js'
import {
  createQdrantClient,
  pointsForFilenames,
} from './search/qdrant.js'

dotenv.config()

const payloadValue = (value) => (typeof value === 'string' ? value : '')

const preferredPoint = (current, candidate) => {
  if (!current) return candidate
  const priority = (point) => {
    if (point.payload?.pointKind === 'root') return 3
    if (!point.payload?.pointKind) return 2
    return 1
  }
  return priority(candidate) > priority(current) ? candidate : current
}

const readLegacyRows = async (candidates) => {
  for (const filename of candidates.filter(Boolean)) {
    try {
      const rows = parse(await fsp.readFile(filename, 'utf8'), {
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
      })
      return {
        filename,
        rows: new Map(rows
          .filter((row) => row[0])
          .map((row) => [row[0], {
            creator: row[1] || '',
            modified: row[2] || '',
            discordMessageId: row[3] || '',
          }])),
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return { filename: '', rows: new Map() }
}

const qdrantMetadata = async ({ client, collectionName, filenames }) => {
  const pointsByFilename = new Map()
  const batchSize = 128

  for (let index = 0; index < filenames.length; index += batchSize) {
    const points = await pointsForFilenames({
      client,
      collectionName,
      filenames: filenames.slice(index, index + batchSize),
    })
    points.forEach((point) => {
      const filename = payloadValue(point.payload?.filename)
      if (!filename) return
      pointsByFilename.set(
        filename,
        preferredPoint(pointsByFilename.get(filename), point),
      )
    })
  }

  return pointsByFilename
}

export const reconcileMediaStore = async ({
  config = getSearchConfig(),
  legacyIndexPath = process.env.LEGACY_INDEX_PATH || '',
  dryRun = false,
  logger = console,
} = {}) => {
  await ensureMediaStoreDirectory(config.mediaDbPath)
  const store = createMediaStore(config.mediaDbPath)

  try {
    const existing = new Set(store.listMedia().map((row) => row.filename))
    const entries = await fsp.readdir(config.uploadDirectory, {
      withFileTypes: true,
    })
    const candidates = []
    let skippedUnknown = 0
    let skippedEmpty = 0

    for (const entry of entries) {
      if (!entry.isFile() || existing.has(entry.name)) continue
      const mediaType = mediaTypeForFilename(entry.name)
      if (mediaType === 'unknown') {
        skippedUnknown += 1
        continue
      }
      const stat = await fsp.stat(path.join(config.uploadDirectory, entry.name))
      if (stat.size === 0) {
        skippedEmpty += 1
        continue
      }
      candidates.push({ filename: entry.name, mediaType, stat })
    }

    const legacy = await readLegacyRows([
      legacyIndexPath,
      path.join(config.uploadDirectory, 'indeksi.csv.old'),
      path.join(config.uploadDirectory, 'indeksi.csv'),
    ])
    const client = createQdrantClient(config)
    const points = await qdrantMetadata({
      client,
      collectionName: config.qdrantCollection,
      filenames: candidates.map(({ filename }) => filename),
    })

    let restored = 0
    let fromQdrant = 0
    let fromLegacyIndex = 0
    let fromFilesystem = 0
    let previewsQueued = 0

    for (const candidate of candidates) {
      const point = points.get(candidate.filename)
      const payload = point?.payload || {}
      const legacyRow = legacy.rows.get(candidate.filename) || {}
      const hasQdrantMetadata = Boolean(point)
      const hasLegacyMetadata = !hasQdrantMetadata && Boolean(
        legacyRow.creator || legacyRow.modified || legacyRow.discordMessageId,
      )

      if (hasQdrantMetadata) fromQdrant += 1
      else if (hasLegacyMetadata) fromLegacyIndex += 1
      else fromFilesystem += 1

      if (dryRun) continue

      store.saveRecoveredMedia({
        filename: candidate.filename,
        title: payloadValue(payload.name) || readableFilename(candidate.filename),
        creator: payloadValue(payload.creator) || legacyRow.creator || '',
        modified: payloadValue(payload.modified)
          || legacyRow.modified
          || new Date(candidate.stat.mtimeMs).toISOString(),
        discordMessageId: payloadValue(payload.discordMessageId)
          || legacyRow.discordMessageId
          || '',
        mediaType: candidate.mediaType,
        extension: fileExtension(candidate.filename),
        fileSize: candidate.stat.size,
        fileMtimeMs: Math.trunc(candidate.stat.mtimeMs),
        checksum: payloadValue(payload.checksum),
        previewStatus: 'pending',
        previewVersion: 0,
      })
      restored += 1
      if (candidate.mediaType !== 'audio') previewsQueued += 1
    }

    const summary = {
      event: 'media_store_reconciled',
      dryRun,
      mediaDirectory: config.uploadDirectory,
      mediaDbPath: config.mediaDbPath,
      legacyIndexPath: legacy.filename,
      existing: existing.size,
      missing: candidates.length,
      restored,
      fromQdrant,
      fromLegacyIndex,
      fromFilesystem,
      previewsQueued,
      skippedUnknown,
      skippedEmpty,
    }
    logger.log(JSON.stringify(summary, null, 2))
    return summary
  } finally {
    store.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reconcileMediaStore({ dryRun: process.argv.includes('--dry-run') }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
