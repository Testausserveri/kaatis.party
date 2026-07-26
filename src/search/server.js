import http from 'http'
import { getSearchConfig } from './config.js'
import { createGeminiClient, embedQuery } from './gemini.js'
import { pointIdForFilename } from './media.js'
import { createQdrantClient, pointToSearchResult } from './qdrant.js'

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

const searchResults = ({ points, excludedFilenames, limit }) => points
  .filter((point) => !excludedFilenames.has(point.payload?.filename))
  .slice(0, limit)
  .map(pointToSearchResult)

const similarResults = ({ points, filename, limit }) => points
  .filter((point) => point.payload?.filename !== filename)
  .slice(0, limit)
  .map(pointToSearchResult)

const normalizeQuery = (query) => query.trim().replace(/\s+/g, ' ')

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
} = {}) => {
  const getQueryEmbedding = createQueryEmbeddingCache({ client, config, embedQueryFn })
  const rateLimiter = createRateLimiter({ config })

  return async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)

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

        const points = await client.query(config.qdrantCollection, {
          query: sourcePoint.vector,
          limit: limit + 1,
          with_payload: true,
          with_vector: false,
        })
        const results = similarResults({ points: points.points, filename, limit })

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
    const vectorLimit = excludedFilenames.size > 0
      ? Math.min(config.maxSearchLimit, limit + excludedFilenames.size + 10)
      : limit
    const useQueryCache = (
      shouldUseQueryCache(url.searchParams.get('cache'))
      || !internalRequest
    )

    try {
      const gemini = ai || createGeminiClient(config)
      const queryEmbedding = await getQueryEmbedding({ ai: gemini, query, useCache: useQueryCache })
      const points = await client.query(config.qdrantCollection, {
        query: queryEmbedding.vector,
        limit: vectorLimit,
        score_threshold: config.minSearchScore > 0 ? config.minSearchScore : undefined,
        with_payload: true,
        with_vector: false,
      })

      const results = searchResults({
        points: points.points,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = getSearchConfig()
  const server = createSearchServer({ config })
  server.listen(config.searchPort, '0.0.0.0', () => {
    console.log(`Search API listening on ${config.searchPort}`)
  })
}
