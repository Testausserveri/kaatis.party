import http from 'http'
import { getSearchConfig } from './config.js'
import { createGeminiClient, embedQuery } from './gemini.js'
import { deleteMediaFilesFromIndex, indexMediaFile } from './indexer.js'
import { pointIdForFilename } from './media.js'
import {
  createQdrantClient,
  ensureCollection,
  mergeRankedMediaPoints,
  queryBalancedMediaPoints,
} from './qdrant.js'
import {
  createMediaStore,
  mediaToApiItem,
  mediaTypeForFilename,
} from '../mediaStore.js'

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

export const parseLimit = ({ value, config }) => {
  const parsed = Number(value || config.defaultSearchLimit)
  if (!Number.isFinite(parsed) || parsed <= 0) return config.defaultSearchLimit
  return Math.min(Math.trunc(parsed), config.maxSearchLimit)
}

export const parseExcludedFilenames = (value) => new Set(String(value || '')
  .split(',')
  .map((filename) => filename.trim())
  .filter(Boolean))

const pointFilename = (point) => point.payload?.filename || ''

const hydratePointResults = ({
  points,
  store,
  config,
  excludedFilenames = new Set(),
  limit,
}) => {
  const filenames = points
    .map(pointFilename)
    .filter((filename) => filename && !excludedFilenames.has(filename))
  const mediaByFilename = store.mediaByFilenames(filenames)
  const results = []

  for (const point of points) {
    const filename = pointFilename(point)
    if (!filename || excludedFilenames.has(filename)) continue

    const row = mediaByFilename.get(filename)
    if (!row) continue

    results.push({
      ...mediaToApiItem(row, { publicBaseUrl: config.publicBaseUrl }),
      score: point.score,
      similarityScore: point.similarityScore ?? point.score,
      matchedModality: point.payload?.modality || 'image',
      matchStartSeconds: point.payload?.startSeconds,
      matchEndSeconds: point.payload?.endSeconds,
      embeddingTruncated: Boolean(point.payload?.embeddingTruncated),
    })
  }

  return mergeRankedMediaPoints({
    imagePoints: results.filter((result) => result.type === 'image'),
    videoPoints: results.filter((result) => result.type === 'video'),
    limit,
  })
}

const normalizeQuery = (query) => String(query || '').trim().replace(/\s+/g, ' ')

const filenamesFromBody = (body) => (
  Array.isArray(body.filenames) ? body.filenames : [body.filename]
).map(normalizeQuery).filter(Boolean)

const readJsonBody = (request, { maxBytes = 16 * 1024 } = {}) => new Promise((resolve, reject) => {
  let body = ''

  request.on('data', (chunk) => {
    body += chunk
    if (Buffer.byteLength(body) > maxBytes) {
      reject(new Error('body_too_large'))
      request.destroy()
    }
  })

  request.on('end', () => {
    if (!body.trim()) {
      resolve({})
      return
    }

    try {
      resolve(JSON.parse(body))
    } catch {
      reject(new Error('invalid_json'))
    }
  })

  request.on('error', reject)
})

export const shouldUseQueryCache = (value) => {
  if (value === null) return true
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

const internalTokenHeader = 'x-kaatis-internal-token'

export const isInternalRequest = ({ request, config }) => (
  Boolean(config.searchInternalToken)
  && request.headers[internalTokenHeader] === config.searchInternalToken
)

const clientAddress = (request) => {
  const forwardedFor = String(request.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  return forwardedFor || request.socket?.remoteAddress || 'unknown'
}

const createRateLimiter = ({ config }) => {
  const buckets = new Map()

  const consumeBucket = ({ key, max, now }) => {
    if (max <= 0) return { allowed: true }
    const current = buckets.get(key)
    if (!current || current.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + config.searchRateLimitWindowMs,
      })
      return { allowed: true }
    }

    current.count += 1
    if (current.count <= max) return { allowed: true }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    }
  }

  return ({ request, now = Date.now() }) => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }

    const globalLimit = consumeBucket({
      key: 'global',
      max: config.searchGlobalRateLimitMax,
      now,
    })
    if (!globalLimit.allowed) return globalLimit

    return consumeBucket({
      key: `ip:${clientAddress(request)}`,
      max: config.searchRateLimitMax,
      now,
    })
  }
}

const queryCacheExpiresAt = (config) => (config.queryCacheTtlMs > 0
  ? Date.now() + config.queryCacheTtlMs
  : Number.POSITIVE_INFINITY)

const isCacheExpired = (entry) => entry.expiresAt <= Date.now()

const createQueryEmbeddingCache = ({ client, config, embedQueryFn }) => {
  const cache = new Map()
  let persistentCacheReady = false

  const ensurePersistentCache = async () => {
    if (!config.persistentQueryCache || persistentCacheReady) return config.persistentQueryCache

    const exists = await client.collectionExists(config.qdrantQueryCacheCollection)
    if (!exists.exists) {
      await client.createCollection(config.qdrantQueryCacheCollection, {
        vectors: {
          size: config.embeddingDimensions,
          distance: 'Cosine',
        },
        on_disk_payload: true,
      })
    }
    persistentCacheReady = true
    return true
  }

  const persistentCacheGet = async ({ id, key, query }) => {
    if (!config.persistentQueryCache) return null

    try {
      await ensurePersistentCache()
      const points = await client.retrieve(config.qdrantQueryCacheCollection, {
        ids: [id],
        with_payload: true,
        with_vector: true,
      })
      const point = points[0]
      const payload = point?.payload || {}

      if (
        point?.vector
        && payload.key === key
        && payload.query === query
        && payload.embeddingModel === config.embeddingModel
        && Number(payload.embeddingDimensions) === config.embeddingDimensions
        && payload.embeddingInputVersion === config.embeddingInputVersion
      ) {
        return point.vector
      }
    } catch (e) {
      console.error(`Pysyvän hakuvälimuistin luku epäonnistui: ${e.message}`)
    }

    return null
  }

  const persistentCacheSet = async ({
    id,
    key,
    query,
    vector,
  }) => {
    if (!config.persistentQueryCache) return

    try {
      await ensurePersistentCache()
      await client.upsert(config.qdrantQueryCacheCollection, {
        wait: true,
        points: [{
          id,
          vector,
          payload: {
            key,
            query,
            embeddingModel: config.embeddingModel,
            embeddingDimensions: config.embeddingDimensions,
            embeddingInputVersion: config.embeddingInputVersion,
            createdAt: new Date().toISOString(),
          },
        }],
      })
    } catch (e) {
      console.error(`Pysyvän hakuvälimuistin kirjoitus epäonnistui: ${e.message}`)
    }
  }

  return async ({ ai, query, useCache = true }) => {
    if (!useCache) {
      return {
        vector: await embedQueryFn({ ai, query, config }),
        cached: false,
      }
    }

    const key = [
      config.embeddingModel,
      config.embeddingDimensions,
      config.embeddingInputVersion,
      query.toLowerCase(),
    ].join(':')
    const id = pointIdForFilename(`query:${key}`)
    const cached = cache.get(key)

    if (cached && !isCacheExpired(cached)) {
      cache.delete(key)
      cache.set(key, cached)
      return { vector: cached.vector, cached: 'memory' }
    }

    const persistentVector = await persistentCacheGet({ id, key, query })
    if (persistentVector) {
      cache.set(key, {
        vector: persistentVector,
        expiresAt: queryCacheExpiresAt(config),
      })
      return { vector: persistentVector, cached: 'persistent' }
    }

    const vector = await embedQueryFn({ ai, query, config })
    cache.set(key, {
      vector,
      expiresAt: queryCacheExpiresAt(config),
    })

    while (cache.size > config.queryCacheMaxEntries) {
      cache.delete(cache.keys().next().value)
    }

    await persistentCacheSet({
      id,
      key,
      query,
      vector,
    })

    return { vector, cached: false }
  }
}

export const createSearchHandler = ({
  config = getSearchConfig(),
  ai,
  client = createQdrantClient(config),
  embedQueryFn = embedQuery,
  deleteMediaFilesFromIndexFn = deleteMediaFilesFromIndex,
  indexMediaFileFn = indexMediaFile,
  store = createMediaStore(config.mediaDbPath),
} = {}) => {
  const getQueryEmbedding = createQueryEmbeddingCache({ client, config, embedQueryFn })
  const rateLimiter = createRateLimiter({ config })
  let videoIndexQueue = Promise.resolve()

  return async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)

    if (url.pathname === '/api/index') {
      if (!['DELETE', 'POST'].includes(request.method)) {
        sendJson(response, 405, { error: 'method_not_allowed' })
        return
      }

      if (!isInternalRequest({ request, config })) {
        sendJson(response, 403, { error: 'forbidden' })
        return
      }

      let body
      try {
        body = await readJsonBody(request)
      } catch (e) {
        sendJson(response, 400, { error: e.message })
        return
      }

      if (request.method === 'DELETE') {
        const filenames = filenamesFromBody(body)
        if (filenames.length === 0) {
          sendJson(response, 400, { error: 'missing_filename' })
          return
        }

        try {
          const result = await deleteMediaFilesFromIndexFn({
            filenames,
            config,
            client,
            logger: console,
          })
          sendJson(response, 200, result)
        } catch (e) {
          console.error(`Tiedostojen indeksointipoisto epäonnistui: ${e.message}`)
          sendJson(response, 503, { error: 'index_delete_unavailable' })
        }
        return
      }

      const [filename] = filenamesFromBody(body)
      if (!filename) {
        sendJson(response, 400, { error: 'missing_filename' })
        return
      }

      if (mediaTypeForFilename(filename) === 'video') {
        videoIndexQueue = videoIndexQueue
          .then(() => indexMediaFileFn({
            filename,
            config,
            ai,
            client,
            logger: console,
          }))
          .catch((e) => {
            console.error(`Videon ${filename} taustaindeksointi epäonnistui: ${e.message}`)
          })
        sendJson(response, 202, { status: 'queued', filename })
        return
      }

      try {
        const result = await indexMediaFileFn({
          filename,
          config,
          ai,
          client,
          logger: console,
        })
        sendJson(response, result.status === 'not_indexable' ? 422 : 200, result)
      } catch (e) {
        console.error(`Tiedoston ${filename} indeksointipyyntö epäonnistui: ${e.message}`)
        sendJson(response, 503, { error: 'index_unavailable' })
      }
      return
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' })
      return
    }

    if (url.pathname === '/api/search/health') {
      try {
        const exists = await client.collectionExists(config.qdrantCollection)
        const count = exists.exists
          ? await client.count(config.qdrantCollection, { exact: true })
          : { count: 0 }
        sendJson(response, 200, {
          ok: true,
          collection: config.qdrantCollection,
          queryCacheCollection: config.qdrantQueryCacheCollection,
          collectionExists: exists.exists,
          count: count.count,
          embeddingModel: config.embeddingModel,
          embeddingDimensions: config.embeddingDimensions,
          minSearchScore: config.minSearchScore,
          minQueryLength: config.minQueryLength,
          persistentQueryCache: config.persistentQueryCache,
          queryCacheMaxEntries: config.queryCacheMaxEntries,
          queryCacheTtlMs: config.queryCacheTtlMs,
          geminiConfigured: Boolean(config.geminiApiKey),
        })
      } catch (e) {
        sendJson(response, 503, { ok: false, error: e.message })
      }
      return
    }

    if (url.pathname === '/api/media') {
      const limit = url.searchParams.has('limit')
        ? parseLimit({ value: url.searchParams.get('limit'), config })
        : Number.POSITIVE_INFINITY
      const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset') || 0)) || 0)
      const media = store.listMedia()
        .slice(offset, offset + limit)
        .map((row) => mediaToApiItem(row, { publicBaseUrl: config.publicBaseUrl }))

      sendJson(response, 200, {
        count: media.length,
        offset,
        results: media,
      })
      return
    }

    if (url.pathname === '/api/similar') {
      const filename = normalizeQuery(url.searchParams.get('filename') || '')
      if (!filename) {
        sendJson(response, 400, { error: 'missing_filename' })
        return
      }

      const limit = parseLimit({ value: url.searchParams.get('limit'), config })
      const id = pointIdForFilename(filename)

      try {
        const sourcePoints = await client.retrieve(config.qdrantCollection, {
          ids: [id],
          with_payload: true,
          with_vector: true,
        })
        const sourcePoint = sourcePoints[0]

        if (!sourcePoint?.vector) {
          sendJson(response, 404, { error: 'not_indexed', filename })
          return
        }

        const points = await queryBalancedMediaPoints({
          client,
          collectionName: config.qdrantCollection,
          vector: sourcePoint.vector,
          limit: limit * 2,
          scoreThreshold: config.minSearchScore > 0 ? config.minSearchScore : undefined,
          excludedFilenames: new Set([filename]),
          videoAudioScoreThreshold: config.videoAudioMinSearchScore,
          videoStoryboardScoreThreshold: config.videoStoryboardMinSearchScore,
        })
        const results = hydratePointResults({
          points,
          store,
          config,
          excludedFilenames: new Set([filename]),
          limit,
        })

        sendJson(response, 200, {
          filename,
          count: results.length,
          results,
        })
      } catch (e) {
        console.error(`Samankaltaisten haku epäonnistui: ${e.message}`)
        sendJson(response, 503, { error: 'similar_unavailable' })
      }
      return
    }

    if (url.pathname !== '/api/search') {
      sendJson(response, 404, { error: 'not_found' })
      return
    }

    const internalRequest = isInternalRequest({ request, config })
    if (!internalRequest) {
      const rateLimit = rateLimiter({ request })
      if (!rateLimit.allowed) {
        response.writeHead(429, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': String(rateLimit.retryAfterSeconds),
        })
        response.end(JSON.stringify({
          error: 'rate_limited',
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        }))
        return
      }
    }

    const query = normalizeQuery(url.searchParams.get('q') || '')
    if (!query) {
      sendJson(response, 400, { error: 'missing_query' })
      return
    }

    if (query.length < config.minQueryLength) {
      sendJson(response, 400, { error: 'query_too_short', minLength: config.minQueryLength })
      return
    }

    if (query.length > config.maxQueryLength) {
      sendJson(response, 400, { error: 'query_too_long' })
      return
    }

    const limit = parseLimit({ value: url.searchParams.get('limit'), config })
    const excludedFilenames = parseExcludedFilenames(url.searchParams.get('exclude'))
    const useQueryCache = (
      shouldUseQueryCache(url.searchParams.get('cache'))
      || !internalRequest
    )

    try {
      const gemini = ai || createGeminiClient(config)
      const queryEmbedding = await getQueryEmbedding({ ai: gemini, query, useCache: useQueryCache })
      const points = await queryBalancedMediaPoints({
        client,
        collectionName: config.qdrantCollection,
        vector: queryEmbedding.vector,
        limit: limit * 2,
        scoreThreshold: config.minSearchScore > 0 ? config.minSearchScore : undefined,
        excludedFilenames,
        videoAudioScoreThreshold: config.videoAudioMinSearchScore,
        videoStoryboardScoreThreshold: config.videoStoryboardMinSearchScore,
      })

      const results = hydratePointResults({
        points,
        store,
        config,
        excludedFilenames,
        limit,
      })
      sendJson(response, 200, {
        query,
        count: results.length,
        minScore: config.minSearchScore,
        queryCache: queryEmbedding.cached,
        results,
      })
    } catch (e) {
      console.error(`Hakupalvelu epäonnistui: ${e.message}`)
      sendJson(response, 503, { error: 'search_unavailable' })
    }
  }
}

export const createSearchServer = (options = {}) => http.createServer(createSearchHandler(options))

const startSearchServer = async () => {
  const config = getSearchConfig()
  const client = createQdrantClient(config)
  await ensureCollection({ client, config })
  const server = createSearchServer({ config, client })
  server.listen(config.searchPort, '0.0.0.0', () => {
    console.log(`Search API listening on ${config.searchPort}`)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSearchServer().catch((error) => {
    console.error(`Hakupalvelun käynnistys epäonnistui: ${error.message}`)
    process.exitCode = 1
  })
}
