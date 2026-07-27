import fsp from 'fs/promises'
import path from 'path'
import { parse } from 'csv-parse/sync'
import dotenv from 'dotenv'
import {
  createMediaStore,
  ensureMediaStoreDirectory,
  fileExtension,
  mediaTypeForFilename,
} from './mediaStore.js'

dotenv.config()

const uploadDirectory = process.env.UPLOAD_DIR || 'public/'
const legacyIndexPath = path.join(uploadDirectory, 'indeksi.csv')
const mediaDbPath = process.env.MEDIA_DB_PATH || 'data/kaatis.sqlite'

const parseMediaIndex = (csvText) => parse(csvText, {
  relax_column_count: true,
  relax_quotes: true,
  skip_empty_lines: true,
}).map((row) => ({
  filename: row[0] || '',
  creator: row[1] || '',
  modified: row[2] || '',
  discordMessageId: row[3] || '',
})).filter((row) => row.filename)

export const migrateMediaStore = async ({
  sourceIndexPath = legacyIndexPath,
  targetDbPath = mediaDbPath,
  mediaDirectory = uploadDirectory,
  logger = console,
} = {}) => {
  await ensureMediaStoreDirectory(targetDbPath)
  const store = createMediaStore(targetDbPath)
  const rows = parseMediaIndex(await fsp.readFile(sourceIndexPath, 'utf8'))

  let migrated = 0
  let skippedMissing = 0
  let skippedUnknown = 0

  try {
    for (const row of rows) {
      const filePath = path.join(mediaDirectory, row.filename)
      let stat
      try {
        stat = await fsp.stat(filePath)
      } catch (e) {
        if (e.code === 'ENOENT') {
          skippedMissing += 1
          continue
        }
        throw e
      }

      if (!stat.isFile() || stat.size === 0) {
        skippedMissing += 1
        continue
      }

      const mediaType = mediaTypeForFilename(row.filename)
      if (mediaType === 'unknown') {
        skippedUnknown += 1
        continue
      }

      store.upsertMedia({
        filename: row.filename,
        creator: row.creator || '',
        modified: row.modified || new Date(stat.mtimeMs).toISOString(),
        discordMessageId: row.discordMessageId || '',
        mediaType,
        extension: fileExtension(row.filename),
        fileSize: stat.size,
        fileMtimeMs: Math.trunc(stat.mtimeMs),
      })
      migrated += 1
    }
  } finally {
    store.close()
  }

  const summary = {
    sourceIndexPath,
    targetDbPath,
    migrated,
    skippedMissing,
    skippedUnknown,
  }
  logger.log(JSON.stringify(summary, null, 2))
  return summary
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrateMediaStore().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
}
