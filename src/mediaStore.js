import fsp from 'fs/promises'
import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif'])
const videoExtensions = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v', '3gp', 'ogv'])
const audioExtensions = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff'])

export const fileExtension = (filename) => path.extname(filename).slice(1).toLowerCase()

export const mediaTypeForFilename = (filename) => {
  const extension = fileExtension(filename)
  if (imageExtensions.has(extension)) return 'image'
  if (videoExtensions.has(extension)) return 'video'
  if (audioExtensions.has(extension)) return 'audio'
  return 'unknown'
}

export const readableFilename = (filename) => {
  const extension = path.extname(filename)
  const stem = extension ? filename.slice(0, -extension.length) : filename
  const keywords = stem.match(/([a-zA-Z0-9]+)/g) || []
  return keywords.length > 0 ? keywords.join(' ') : stem
}

const mediaUrl = ({ filename, publicBaseUrl }) => {
  if (!publicBaseUrl || publicBaseUrl === '/') return `/${filename}`
  const base = publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`
  return new URL(filename, base).toString()
}

export const mediaToApiItem = (row, { publicBaseUrl = '/' } = {}) => {
  const name = readableFilename(row.filename)
  return {
    filename: row.filename,
    type: row.media_type,
    name,
    keywords: name.toLowerCase().split(/\s+/).filter(Boolean),
    url: mediaUrl({ filename: row.filename, publicBaseUrl }),
    modified: row.modified,
    creator: row.creator,
    discordMessageId: row.discord_message_id || '',
    extension: row.extension,
    fileSize: row.file_size,
    fileMtimeMs: row.file_mtime_ms,
  }
}

export const ensureMediaStoreDirectory = async (dbPath) => {
  await fsp.mkdir(path.dirname(dbPath), { recursive: true })
}

export const createMediaStore = (dbPath) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS media (
      filename TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      modified TEXT NOT NULL,
      discord_message_id TEXT,
      media_type TEXT NOT NULL,
      extension TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_mtime_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_discord_message_id
      ON media(discord_message_id);

    CREATE INDEX IF NOT EXISTS idx_media_modified
      ON media(modified DESC);
  `)

  const upsert = db.prepare(`
    INSERT INTO media (
      filename,
      creator,
      modified,
      discord_message_id,
      media_type,
      extension,
      file_size,
      file_mtime_ms,
      created_at,
      updated_at
    ) VALUES (
      $filename,
      $creator,
      $modified,
      $discordMessageId,
      $mediaType,
      $extension,
      $fileSize,
      $fileMtimeMs,
      $now,
      $now
    )
    ON CONFLICT(filename) DO UPDATE SET
      creator = excluded.creator,
      modified = excluded.modified,
      discord_message_id = excluded.discord_message_id,
      media_type = excluded.media_type,
      extension = excluded.extension,
      file_size = excluded.file_size,
      file_mtime_ms = excluded.file_mtime_ms,
      updated_at = excluded.updated_at
  `)
  const byMessage = db.prepare(`
    SELECT * FROM media
    WHERE discord_message_id = $discordMessageId
    ORDER BY modified DESC, filename ASC
  `)
  const byFilename = db.prepare('SELECT * FROM media WHERE filename = $filename')
  const list = db.prepare('SELECT * FROM media ORDER BY modified DESC, filename ASC')
  const deleteByFilename = db.prepare('DELETE FROM media WHERE filename = $filename')

  return {
    close: () => db.close(),

    upsertMedia: (media) => {
      const now = new Date().toISOString()
      upsert.run({
        $filename: media.filename,
        $creator: media.creator || '',
        $modified: media.modified || now,
        $discordMessageId: media.discordMessageId || '',
        $mediaType: media.mediaType || mediaTypeForFilename(media.filename),
        $extension: media.extension || fileExtension(media.filename),
        $fileSize: Number(media.fileSize) || 0,
        $fileMtimeMs: Number(media.fileMtimeMs) || 0,
        $now: now,
      })
    },

    filenamesForMessage: (discordMessageId) => byMessage
      .all({ $discordMessageId: discordMessageId })
      .map((row) => row.filename),

    mediaByFilename: (filename) => byFilename.get({ $filename: filename }) || null,

    mediaByFilenames: (filenames) => {
      const rows = new Map()
      filenames.forEach((filename) => {
        const row = byFilename.get({ $filename: filename })
        if (row) rows.set(filename, row)
      })
      return rows
    },

    listMedia: () => list.all(),

    deleteMedia: (filenames) => {
      const uniqueFilenames = [...new Set(filenames)]
      db.exec('BEGIN')
      try {
        uniqueFilenames.forEach((filename) => deleteByFilename.run({ $filename: filename }))
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return uniqueFilenames.length
    },
  }
}
