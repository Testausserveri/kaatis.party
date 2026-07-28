import fsp from 'node:fs/promises'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'

import rateLimit from '@fastify/rate-limit'
import type {
  InternalUploadRequest,
  MediaPage,
} from '@kaatis/contracts'
import { Type } from '@sinclair/typebox'
import Fastify from 'fastify'

import {
  createMediaStore,
  mediaToApiItem,
} from '../../../src/mediaStore.js'
import {
  createQdrantClient,
} from '../../../src/search/qdrant.js'
import { safeMediaFilename } from '../../../src/search/media.js'
import { getApiConfig } from './config.ts'
import { createJobRunner } from './jobs.ts'
import { createLegacyIndex } from './legacyIndex.ts'
import { createMediaSearch } from './search.ts'
import { ingestUpload } from './uploads.ts'

const config = getApiConfig()
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
  bodyLimit: 64 * 1024,
  requestIdHeader: 'x-request-id',
  trustProxy: true,
})
const store = createMediaStore(config.mediaDbPath)
const jobs = createJobRunner({
  config,
  store,
  logger: app.log,
})
const search = createMediaSearch({
  config,
  store,
  logger: app.log,
})
const legacyIndex = createLegacyIndex(store)

await app.register(rateLimit, {
  global: false,
  max: config.searchRateLimitMax,
  timeWindow: config.searchRateLimitWindowMs,
  allowList: (request) => (
    Boolean(config.internalToken)
    && request.headers['x-kaatis-internal-token'] === config.internalToken
  ),
})

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('cache-control', 'no-store')
  reply.header('x-content-type-options', 'nosniff')
  return payload
})

const requireInternalToken = async (
  request: { headers: Record<string, unknown> },
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
) => {
  const supplied = String(request.headers['x-kaatis-internal-token'] || '')
  const expected = config.internalToken
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  const allowed = (
    Boolean(expected)
    && suppliedBytes.length === expectedBytes.length
    && timingSafeEqual(suppliedBytes, expectedBytes)
  )
  if (!allowed) {
    return reply.code(403).send({ error: 'forbidden' })
  }
}

const positiveInteger = (
  value: unknown,
  fallback: number,
  maximum: number,
) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.trunc(parsed), maximum)
}

const encodeCursor = (row: Record<string, unknown>) => Buffer
  .from(JSON.stringify([row.modified, row.filename]))
  .toString('base64url')

const decodeCursor = (value: unknown) => {
  if (!value) return { cursorModified: '', cursorFilename: '' }
  try {
    const parsed = JSON.parse(
      Buffer.from(String(value), 'base64url').toString('utf8'),
    )
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || parsed.some((part) => typeof part !== 'string')
    ) {
      throw new Error('invalid_cursor')
    }
    return {
      cursorModified: parsed[0],
      cursorFilename: parsed[1],
    }
  } catch {
    throw new Error('invalid_cursor')
  }
}

app.get('/api/media', {
  schema: {
    querystring: Type.Object({
      cursor: Type.Optional(Type.String({ maxLength: 1024 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    }),
  },
}, async (request, reply): Promise<MediaPage> => {
  const query = request.query as { cursor?: string, limit?: number }
  const limit = positiveInteger(query.limit, 60, 120)
  let cursor
  try {
    cursor = decodeCursor(query.cursor)
  } catch {
    return reply.code(400).send({ error: 'invalid_cursor' }) as never
  }
  const rows = store.listMediaPage({
    ...cursor,
    limit: limit + 1,
  })
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)

  return {
    count: page.length,
    nextCursor: hasMore && page.length > 0
      ? encodeCursor(page[page.length - 1])
      : null,
    results: page.map((row: Record<string, unknown>) => (
      mediaToApiItem(row, { publicBaseUrl: config.publicBaseUrl })
    )),
  }
})

app.get('/api/media/:filename', {
  schema: {
    params: Type.Object({
      filename: Type.String({ minLength: 1, maxLength: 255 }),
    }),
  },
}, async (request, reply) => {
  const { filename } = request.params as { filename: string }
  const safe = safeMediaFilename(filename)
  const row = safe ? store.mediaByFilename(safe) : null
  if (!row) return reply.code(404).send({ error: 'not_found' })
  return mediaToApiItem(row, { publicBaseUrl: config.publicBaseUrl })
})

app.get('/legacy-index', async (request, reply) => {
  reply.type('text/html; charset=utf-8')
  return legacyIndex.render(request.raw.url || '/legacy-index')
})

app.get('/api/search', {
  config: {
    rateLimit: {
      max: config.searchRateLimitMax,
      timeWindow: config.searchRateLimitWindowMs,
    },
  },
  schema: {
    querystring: Type.Object({
      q: Type.String({ minLength: 2, maxLength: config.maxQueryLength }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 80 })),
      type: Type.Optional(Type.Union([
        Type.Literal('image'),
        Type.Literal('video'),
        Type.Literal('audio'),
      ])),
      exclude: Type.Optional(Type.String({ maxLength: 12000 })),
    }),
  },
}, async (request) => {
  const query = request.query as {
    q: string
    limit?: number
    type?: string
    exclude?: string
  }
  return search.search({
    query: query.q.trim().replace(/\s+/g, ' '),
    limit: positiveInteger(query.limit, 60, 80),
    type: query.type,
    excludedFilenames: new Set(
      String(query.exclude || '')
        .split(',')
        .map((filename) => filename.trim())
        .filter(Boolean),
    ),
  })
})

app.get('/api/media/:filename/similar', {
  config: {
    rateLimit: {
      max: config.searchRateLimitMax,
      timeWindow: config.searchRateLimitWindowMs,
    },
  },
  schema: {
    params: Type.Object({
      filename: Type.String({ minLength: 1, maxLength: 255 }),
    }),
    querystring: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
    }),
  },
}, async (request, reply) => {
  const { filename } = request.params as { filename: string }
  const { limit } = request.query as { limit?: number }
  const result = await search.similar({
    filename,
    limit: positiveInteger(limit, 24, 40),
  })
  if (!result) return reply.code(404).send({ error: 'not_indexed' })
  return result
})

app.get('/api/healthz', async (_request, reply) => {
  const qdrant = createQdrantClient(config)
  try {
    const exists = await qdrant.collectionExists(config.qdrantCollection)
    return {
      ok: true,
      qdrant: exists.exists,
      pendingJobs: store.pendingJobCount(),
    }
  } catch {
    return reply.code(503).send({
      ok: false,
      qdrant: false,
      pendingJobs: store.pendingJobCount(),
    })
  }
})

app.post('/internal/media', {
  preHandler: requireInternalToken,
  schema: {
    body: Type.Object({
      sourceUrl: Type.String({ minLength: 1, maxLength: 4096 }),
      originalFilename: Type.String({ minLength: 1, maxLength: 255 }),
      requestedName: Type.String({ maxLength: 500 }),
      creator: Type.String({ minLength: 1, maxLength: 255 }),
      modified: Type.String({ minLength: 1, maxLength: 64 }),
      discordMessageId: Type.String({ minLength: 1, maxLength: 64 }),
    }),
  },
}, async (request, reply) => {
  try {
    const row = await ingestUpload({
      input: request.body as InternalUploadRequest,
      config,
      store,
    })
    return reply.code(201).send({
      status: 'accepted',
      media: mediaToApiItem(row, { publicBaseUrl: config.publicBaseUrl }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    app.log.error({
      event: 'media_upload_failed',
      error: message,
    })
    const clientErrors = new Set([
      'empty_file',
      'file_too_large',
      'invalid_extension',
      'source_url_not_allowed',
      'unsupported_media_type',
    ])
    return reply
      .code(clientErrors.has(message) ? 422 : 502)
      .send({ error: message })
  }
})

app.delete('/internal/media/by-message/:messageId', {
  preHandler: requireInternalToken,
  schema: {
    params: Type.Object({
      messageId: Type.String({ minLength: 1, maxLength: 64 }),
    }),
  },
}, async (request) => {
  const { messageId } = request.params as { messageId: string }
  const rows = store.mediaForMessage(messageId)
  store.deleteMediaAndEnqueue(
    rows.map((row: Record<string, unknown>) => String(row.filename)),
  )

  for (const row of rows) {
    try {
      await fsp.rm(
        path.join(config.uploadDirectory, String(row.filename)),
        { force: true },
      )
    } catch (error) {
      app.log.error({
        event: 'media_file_delete_failed',
        filename: row.filename,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const row of rows) {
    await jobs.removePreviewIfUnused(
      String(row.checksum || ''),
      Number(store.mediaCountForChecksum(String(row.checksum || ''))),
    )
  }

  return {
    deleted: rows.length,
    filenames: rows.map((row: Record<string, unknown>) => row.filename),
  }
})

const runningWorkers = jobs.start()
let shuttingDown = false

const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  jobs.stop()
  await app.close()
  store.close()
  await Promise.allSettled(runningWorkers)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

try {
  await app.listen({
    port: config.apiPort,
    host: config.apiHost,
  })
} catch (error) {
  app.log.error(error)
  jobs.stop()
  await Promise.allSettled(runningWorkers)
  store.close()
  process.exitCode = 1
}
