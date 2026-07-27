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
  const keywords = stem.match(/([\p{L}\p{N}]+)/gu) || []
  return keywords.length > 0 ? keywords.join(' ') : stem
}

const mediaUrl = ({ filename, publicBaseUrl }) => {
  if (!publicBaseUrl || publicBaseUrl === '/') return `/${encodeURIComponent(filename)}`
  const base = publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`
  return new URL(encodeURIComponent(filename), base).toString()
}

const previewUrl = ({ checksum, version, width }) => (
  `/thumbs/v${version}/${checksum}/${width}.webp`
)

export const mediaToApiItem = (row, { publicBaseUrl = '/' } = {}) => {
  const name = row.title || readableFilename(row.filename)
  const previewVersion = Number(row.preview_version) || 1
  const hasPreview = (
    row.preview_status === 'ready'
    && Boolean(row.checksum)
    && row.media_type !== 'audio'
  )
  const preview = hasPreview
    ? {
      src: previewUrl({
        checksum: row.checksum,
        version: previewVersion,
        width: 640,
      }),
      srcSet: [320, 640, 1280]
        .map((width) => `${previewUrl({
          checksum: row.checksum,
          version: previewVersion,
          width,
        })} ${width}w`)
        .join(', '),
      ...(row.media_type === 'video'
        ? {
          motion: `/thumbs/v${previewVersion}/${row.checksum}/preview.webm`,
        }
        : {}),
    }
    : undefined

  return {
    filename: row.filename,
    type: row.media_type,
    name,
    url: mediaUrl({ filename: row.filename, publicBaseUrl }),
    modified: row.modified,
    creator: row.creator,
    extension: row.extension,
    fileSize: row.file_size,
    width: row.width || 0,
    height: row.height || 0,
    durationMs: row.duration_ms || 0,
    dominantColor: row.dominant_color || '#171717',
    previewStatus: row.preview_status || 'pending',
    ...(preview ? { preview } : {}),
  }
}

export const ensureMediaStoreDirectory = async (dbPath) => {
  await fsp.mkdir(path.dirname(dbPath), { recursive: true })
}

const ensureColumns = (db, table, columns) => {
  const current = new Set(db.prepare(`PRAGMA table_info(${table})`).all()
    .map((column) => column.name))
  Object.entries(columns).forEach(([name, definition]) => {
    if (!current.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  })
}

const ftsQuery = (query) => {
  const tokens = String(query || '')
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || []

  return [...new Set(tokens)]
    .slice(0, 12)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(' AND ')
}

const nowIso = () => new Date().toISOString()

export const createMediaStore = (dbPath) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

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
  `)

  ensureColumns(db, 'media', {
    title: "TEXT NOT NULL DEFAULT ''",
    checksum: "TEXT NOT NULL DEFAULT ''",
    width: 'INTEGER NOT NULL DEFAULT 0',
    height: 'INTEGER NOT NULL DEFAULT 0',
    duration_ms: 'INTEGER NOT NULL DEFAULT 0',
    dominant_color: "TEXT NOT NULL DEFAULT '#171717'",
    preview_status: "TEXT NOT NULL DEFAULT 'pending'",
    preview_version: 'INTEGER NOT NULL DEFAULT 0',
  })

  const schemaVersion = Number(
    db.prepare('PRAGMA user_version').get().user_version,
  )
  if (schemaVersion < 1) {
    db.exec(`
      DROP TRIGGER IF EXISTS media_fts_insert;
      DROP TRIGGER IF EXISTS media_fts_delete;
      DROP TRIGGER IF EXISTS media_fts_update;
      DROP TABLE IF EXISTS media_fts;
    `)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_discord_message_id
      ON media(discord_message_id);

    CREATE INDEX IF NOT EXISTS idx_media_modified
      ON media(modified DESC, filename ASC);

    CREATE INDEX IF NOT EXISTS idx_media_checksum
      ON media(checksum);

    CREATE TABLE IF NOT EXISTS media_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      locked_at TEXT,
      finished_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_jobs_queue
      ON media_jobs(status, available_at, id);

    CREATE INDEX IF NOT EXISTS idx_media_jobs_filename
      ON media_jobs(filename, status);

    CREATE TABLE IF NOT EXISTS gemini_batches (
      name TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      input_file_name TEXT NOT NULL DEFAULT '',
      output_file_name TEXT NOT NULL DEFAULT '',
      imported INTEGER NOT NULL DEFAULT 0,
      batch_stats_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gemini_batch_items (
      batch_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(batch_name, filename),
      FOREIGN KEY(batch_name) REFERENCES gemini_batches(name) ON DELETE CASCADE
    );
  `)

  ensureColumns(db, 'gemini_batches', {
    metadata_json: "TEXT NOT NULL DEFAULT '{}'",
  })
  ensureColumns(db, 'gemini_batch_items', {
    position: 'INTEGER NOT NULL DEFAULT 0',
  })

  const updateMissingTitle = db.prepare(`
    UPDATE media SET title = $title WHERE filename = $filename
  `)
  db.prepare("SELECT filename FROM media WHERE title = ''")
    .all()
    .forEach((row) => updateMissingTitle.run({
      $filename: row.filename,
      $title: readableFilename(row.filename),
    }))

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
      filename,
      title,
      creator,
      content='media',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS media_fts_insert AFTER INSERT ON media BEGIN
      INSERT INTO media_fts(rowid, filename, title, creator)
      VALUES (
        new.rowid,
        new.filename,
        new.title,
        new.creator
      );
    END;

    CREATE TRIGGER IF NOT EXISTS media_fts_delete AFTER DELETE ON media BEGIN
      INSERT INTO media_fts(media_fts, rowid, filename, title, creator)
      VALUES (
        'delete',
        old.rowid,
        old.filename,
        old.title,
        old.creator
      );
    END;

    CREATE TRIGGER IF NOT EXISTS media_fts_update AFTER UPDATE ON media BEGIN
      INSERT INTO media_fts(media_fts, rowid, filename, title, creator)
      VALUES (
        'delete',
        old.rowid,
        old.filename,
        old.title,
        old.creator
      );
      INSERT INTO media_fts(rowid, filename, title, creator)
      VALUES (
        new.rowid,
        new.filename,
        new.title,
        new.creator
      );
    END;
  `)

  if (schemaVersion < 1) {
    db.exec("INSERT INTO media_fts(media_fts) VALUES('rebuild')")
    db.exec('PRAGMA user_version = 1')
  }

  const upsert = db.prepare(`
    INSERT INTO media (
      filename,
      title,
      creator,
      modified,
      discord_message_id,
      media_type,
      extension,
      file_size,
      file_mtime_ms,
      checksum,
      width,
      height,
      duration_ms,
      dominant_color,
      preview_status,
      preview_version,
      created_at,
      updated_at
    ) VALUES (
      $filename,
      $title,
      $creator,
      $modified,
      $discordMessageId,
      $mediaType,
      $extension,
      $fileSize,
      $fileMtimeMs,
      $checksum,
      $width,
      $height,
      $durationMs,
      $dominantColor,
      $previewStatus,
      $previewVersion,
      $now,
      $now
    )
    ON CONFLICT(filename) DO UPDATE SET
      title = excluded.title,
      creator = excluded.creator,
      modified = excluded.modified,
      discord_message_id = excluded.discord_message_id,
      media_type = excluded.media_type,
      extension = excluded.extension,
      file_size = excluded.file_size,
      file_mtime_ms = excluded.file_mtime_ms,
      checksum = CASE
        WHEN excluded.checksum = '' THEN media.checksum
        ELSE excluded.checksum
      END,
      width = CASE WHEN excluded.width = 0 THEN media.width ELSE excluded.width END,
      height = CASE WHEN excluded.height = 0 THEN media.height ELSE excluded.height END,
      duration_ms = CASE
        WHEN excluded.duration_ms = 0 THEN media.duration_ms
        ELSE excluded.duration_ms
      END,
      dominant_color = CASE
        WHEN excluded.dominant_color = '' THEN media.dominant_color
        ELSE excluded.dominant_color
      END,
      preview_status = excluded.preview_status,
      preview_version = excluded.preview_version,
      updated_at = excluded.updated_at
  `)
  const byMessage = db.prepare(`
    SELECT * FROM media
    WHERE discord_message_id = $discordMessageId
    ORDER BY modified DESC, filename ASC
  `)
  const byFilename = db.prepare('SELECT * FROM media WHERE filename = $filename')
  const list = db.prepare('SELECT * FROM media ORDER BY modified DESC, filename ASC')
  const listPage = db.prepare(`
    SELECT * FROM media
    WHERE (
      $cursorModified = ''
      OR modified < $cursorModified
      OR (modified = $cursorModified AND filename > $cursorFilename)
    )
    ORDER BY modified DESC, filename ASC
    LIMIT $limit
  `)
  const search = db.prepare(`
    SELECT
      media.*,
      bm25(media_fts, 1.4, 1.8, 0.8) AS text_rank,
      CASE
        WHEN lower(media.filename) = lower($rawQuery) THEN 0
        WHEN lower(media.title) = lower($rawQuery) THEN 1
        WHEN lower(media.filename) LIKE lower($prefixQuery) THEN 2
        WHEN lower(media.title) LIKE lower($prefixQuery) THEN 3
        ELSE 4
      END AS exact_rank
    FROM media_fts
    JOIN media ON media.rowid = media_fts.rowid
    WHERE media_fts MATCH $ftsQuery
    ORDER BY exact_rank ASC, text_rank ASC, media.modified DESC
    LIMIT $limit
  `)
  const deleteByFilename = db.prepare('DELETE FROM media WHERE filename = $filename')
  const updatePreview = db.prepare(`
    UPDATE media
    SET
      checksum = $checksum,
      width = $width,
      height = $height,
      duration_ms = $durationMs,
      dominant_color = $dominantColor,
      preview_status = $previewStatus,
      preview_version = $previewVersion,
      updated_at = $now
    WHERE filename = $filename
  `)
  const enqueueJob = db.prepare(`
    INSERT INTO media_jobs (
      kind,
      filename,
      status,
      attempts,
      available_at,
      created_at,
      updated_at
    )
    SELECT
      $kind,
      $filename,
      'pending',
      0,
      $now,
      $now,
      $now
    WHERE NOT EXISTS (
      SELECT 1 FROM media_jobs
      WHERE kind = $kind
        AND filename = $filename
        AND status IN ('pending', 'running')
    )
  `)
  const claimJob = db.prepare(`
    UPDATE media_jobs
    SET
      status = 'running',
      attempts = attempts + 1,
      locked_at = $now,
      updated_at = $now
    WHERE id = (
      SELECT id FROM media_jobs
      WHERE status = 'pending' AND available_at <= $now
      ORDER BY id ASC
      LIMIT 1
    )
    RETURNING *
  `)
  const completeJob = db.prepare(`
    UPDATE media_jobs
    SET status = 'done', finished_at = $now, updated_at = $now, last_error = ''
    WHERE id = $id
  `)
  const retryJob = db.prepare(`
    UPDATE media_jobs
    SET
      status = CASE WHEN attempts >= $maxAttempts THEN 'failed' ELSE 'pending' END,
      available_at = $availableAt,
      locked_at = NULL,
      finished_at = CASE WHEN attempts >= $maxAttempts THEN $now ELSE NULL END,
      last_error = $error,
      updated_at = $now
    WHERE id = $id
  `)
  const upsertBatch = db.prepare(`
    INSERT INTO gemini_batches (
      name,
      state,
      input_file_name,
      output_file_name,
      imported,
      batch_stats_json,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (
      $name,
      $state,
      $inputFileName,
      $outputFileName,
      $imported,
      $batchStats,
      $metadata,
      $createdAt,
      $now
    )
    ON CONFLICT(name) DO UPDATE SET
      state = excluded.state,
      input_file_name = excluded.input_file_name,
      output_file_name = excluded.output_file_name,
      imported = excluded.imported,
      batch_stats_json = excluded.batch_stats_json,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `)
  const insertBatchItem = db.prepare(`
    INSERT INTO gemini_batch_items (
      batch_name,
      filename,
      manifest_json,
      position
    )
    VALUES ($batchName, $filename, $manifest, $position)
    ON CONFLICT(batch_name, filename) DO UPDATE SET
      manifest_json = excluded.manifest_json,
      position = excluded.position
  `)
  const batchRows = db.prepare(`
    SELECT * FROM gemini_batches ORDER BY created_at ASC
  `)
  const batchItemRows = db.prepare(`
    SELECT manifest_json
    FROM gemini_batch_items
    WHERE batch_name = $batchName
    ORDER BY position ASC
  `)

  const mediaParameters = (media) => {
    const now = nowIso()
    const filename = media.filename
    return {
      $filename: filename,
      $title: media.title || readableFilename(filename),
      $creator: media.creator || '',
      $modified: media.modified || now,
      $discordMessageId: media.discordMessageId || '',
      $mediaType: media.mediaType || mediaTypeForFilename(filename),
      $extension: media.extension || fileExtension(filename),
      $fileSize: Number(media.fileSize) || 0,
      $fileMtimeMs: Number(media.fileMtimeMs) || 0,
      $checksum: media.checksum || '',
      $width: Number(media.width) || 0,
      $height: Number(media.height) || 0,
      $durationMs: Number(media.durationMs) || 0,
      $dominantColor: media.dominantColor || '#171717',
      $previewStatus: media.previewStatus || 'pending',
      $previewVersion: Number(media.previewVersion) || 0,
      $now: now,
    }
  }

  const saveBatch = (batch) => {
    const now = nowIso()
    const {
      name,
      state,
      inputFileName,
      outputFileName,
      imported,
      batchStats,
      createdAt,
      items,
      ...metadata
    } = batch
    upsertBatch.run({
      $name: name,
      $state: state || 'JOB_STATE_PENDING',
      $inputFileName: inputFileName || '',
      $outputFileName: outputFileName || '',
      $imported: imported ? 1 : 0,
      $batchStats: JSON.stringify(batchStats || {}),
      $metadata: JSON.stringify(metadata),
      $createdAt: createdAt || now,
      $now: now,
    })
    const currentItems = items || []
    currentItems.forEach((item, position) => insertBatchItem.run({
      $batchName: name,
      $filename: item.filename,
      $manifest: JSON.stringify(item),
      $position: position,
    }))
  }

  return {
    close: () => db.close(),

    upsertMedia: (media) => {
      const parameters = mediaParameters(media)
      upsert.run(parameters)
      return byFilename.get({ $filename: parameters.$filename })
    },

    saveUploadedMedia: (media) => {
      const parameters = mediaParameters(media)
      db.exec('BEGIN IMMEDIATE')
      try {
        upsert.run(parameters)
        enqueueJob.run({
          $kind: 'preview',
          $filename: parameters.$filename,
          $now: parameters.$now,
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return byFilename.get({ $filename: parameters.$filename })
    },

    filenamesForMessage: (discordMessageId) => byMessage
      .all({ $discordMessageId: discordMessageId })
      .map((row) => row.filename),

    mediaForMessage: (discordMessageId) => byMessage
      .all({ $discordMessageId: discordMessageId }),

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

    listMediaPage: ({
      cursorModified = '',
      cursorFilename = '',
      limit = 60,
    } = {}) => listPage.all({
      $cursorModified: cursorModified,
      $cursorFilename: cursorFilename,
      $limit: limit,
    }),

    searchMedia: (query, limit = 120) => {
      const normalized = String(query || '').trim()
      const expression = ftsQuery(normalized)
      if (!expression) return []
      return search.all({
        $rawQuery: normalized,
        $prefixQuery: `${normalized}%`,
        $ftsQuery: expression,
        $limit: limit,
      })
    },

    updatePreview: ({
      filename,
      checksum,
      width,
      height,
      durationMs = 0,
      dominantColor = '#171717',
      previewStatus,
      previewVersion,
    }) => updatePreview.run({
      $filename: filename,
      $checksum: checksum,
      $width: width,
      $height: height,
      $durationMs: durationMs,
      $dominantColor: dominantColor,
      $previewStatus: previewStatus,
      $previewVersion: previewVersion,
      $now: nowIso(),
    }),

    deleteMedia: (filenames) => {
      const uniqueFilenames = [...new Set(filenames)]
      db.exec('BEGIN')
      try {
        uniqueFilenames.forEach((filename) => deleteByFilename.run({ $filename: filename }))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return uniqueFilenames.length
    },

    deleteMediaAndEnqueue: (filenames) => {
      const uniqueFilenames = [...new Set(filenames)]
      const now = nowIso()
      db.exec('BEGIN IMMEDIATE')
      try {
        uniqueFilenames.forEach((filename) => {
          const row = byFilename.get({ $filename: filename })
          deleteByFilename.run({ $filename: filename })
          const deleteKinds = ['file_delete', 'qdrant_delete']
          deleteKinds.forEach((kind) => {
            enqueueJob.run({
              $kind: kind,
              $filename: filename,
              $now: now,
            })
          })
          if (row?.checksum) {
            enqueueJob.run({
              $kind: 'preview_delete',
              $filename: row.checksum,
              $now: now,
            })
          }
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return uniqueFilenames.length
    },

    enqueueJob: ({ kind, filename }) => enqueueJob.run({
      $kind: kind,
      $filename: filename,
      $now: nowIso(),
    }),

    claimJob: () => claimJob.get({ $now: nowIso() }) || null,

    completeJob: (id) => completeJob.run({ $id: id, $now: nowIso() }),

    failJob: (id, error, { maxAttempts = 5 } = {}) => {
      const row = db.prepare('SELECT attempts FROM media_jobs WHERE id = $id')
        .get({ $id: id })
      const attempts = Number(row?.attempts) || 1
      const delayMs = Math.min(60 * 60 * 1000, 5000 * (2 ** (attempts - 1)))
      return retryJob.run({
        $id: id,
        $maxAttempts: maxAttempts,
        $availableAt: new Date(Date.now() + delayMs).toISOString(),
        $error: String(error || '').slice(0, 2000),
        $now: nowIso(),
      })
    },

    recoverJobs: ({ staleBefore }) => db.prepare(`
      UPDATE media_jobs
      SET status = 'pending', locked_at = NULL, updated_at = $now
      WHERE status = 'running' AND locked_at < $staleBefore
    `).run({
      $staleBefore: staleBefore,
      $now: nowIso(),
    }),

    pendingJobCount: () => db.prepare(`
      SELECT count(*) AS count
      FROM media_jobs
      WHERE status IN ('pending', 'running')
    `).get().count,

    mediaCountForChecksum: (checksum) => db.prepare(`
      SELECT count(*) AS count
      FROM media
      WHERE checksum = $checksum
    `).get({ $checksum: checksum }).count,

    importGeminiBatch: (batch) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        saveBatch(batch)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    listGeminiBatches: () => batchRows.all().map((row) => ({
      ...JSON.parse(row.metadata_json || '{}'),
      name: row.name,
      state: row.state,
      inputFileName: row.input_file_name,
      outputFileName: row.output_file_name,
      imported: Boolean(row.imported),
      batchStats: JSON.parse(row.batch_stats_json || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: batchItemRows.all({ $batchName: row.name })
        .map((item) => JSON.parse(item.manifest_json)),
    })),
  }
}
