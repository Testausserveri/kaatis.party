import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

const numberFromEnv = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const nonNegativeNumberFromEnv = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const booleanFromEnv = (value, fallback) => {
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

export const getSearchConfig = (env = process.env) => {
  const uploadDirectory = env.UPLOAD_DIR || 'public/'

  return {
    uploadDirectory,
    indexPath: env.INDEX_PATH || path.join(uploadDirectory, 'indeksi.csv'),
    publicBaseUrl: env.SEARCH_PUBLIC_BASE_URL || '/',
    qdrantUrl: env.QDRANT_URL || 'http://localhost:6333',
    qdrantApiKey: env.QDRANT_API_KEY || undefined,
    qdrantCollection: env.QDRANT_COLLECTION || 'kaatis_images',
    qdrantQueryCacheCollection: env.QDRANT_QUERY_CACHE_COLLECTION || `${env.QDRANT_COLLECTION || 'kaatis_images'}_query_cache`,
    geminiApiKey: env.GEMINI_API_KEY,
    embeddingModel: env.GEMINI_EMBED_MODEL || 'gemini-embedding-2',
    embeddingDimensions: numberFromEnv(env.GEMINI_EMBED_DIMS, 768),
    embeddingInputVersion: env.SEARCH_EMBEDDING_INPUT_VERSION || 'image-metadata-v2',
    searchPort: numberFromEnv(env.SEARCH_API_PORT, 3000),
    maxSearchLimit: numberFromEnv(env.SEARCH_MAX_LIMIT, 100),
    defaultSearchLimit: numberFromEnv(env.SEARCH_DEFAULT_LIMIT, 30),
    maxQueryLength: numberFromEnv(env.SEARCH_MAX_QUERY_LENGTH, 500),
    minQueryLength: numberFromEnv(env.SEARCH_MIN_QUERY_LENGTH, 2),
    minSearchScore: nonNegativeNumberFromEnv(env.SEARCH_MIN_SCORE, 0.4),
    persistentQueryCache: booleanFromEnv(env.SEARCH_PERSIST_QUERY_CACHE, true),
    queryCacheMaxEntries: numberFromEnv(env.SEARCH_QUERY_CACHE_MAX_ENTRIES, 1000),
    queryCacheTtlMs: nonNegativeNumberFromEnv(env.SEARCH_QUERY_CACHE_TTL_MS, 0),
    searchInternalToken: env.SEARCH_INTERNAL_TOKEN || '',
    searchRateLimitWindowMs: numberFromEnv(env.SEARCH_RATE_LIMIT_WINDOW_MS, 60000),
    searchRateLimitMax: numberFromEnv(env.SEARCH_RATE_LIMIT_MAX, 60),
    searchGlobalRateLimitMax: numberFromEnv(env.SEARCH_GLOBAL_RATE_LIMIT_MAX, 300),
    indexLimit: numberFromEnv(env.SEARCH_INDEX_LIMIT, 0),
    indexMatch: env.SEARCH_INDEX_MATCH || '',
    indexConcurrency: numberFromEnv(env.SEARCH_INDEX_CONCURRENCY, 2),
    qdrantBatchSize: numberFromEnv(env.SEARCH_QDRANT_BATCH_SIZE, 64),
    deleteStale: booleanFromEnv(env.SEARCH_DELETE_STALE, true),
    convertImageBytes: numberFromEnv(env.SEARCH_CONVERT_IMAGE_BYTES, 4 * 1024 * 1024),
    imageMaxDimension: numberFromEnv(env.SEARCH_IMAGE_MAX_DIMENSION, 2048),
    imageJpegQuality: numberFromEnv(env.SEARCH_IMAGE_JPEG_QUALITY, 85),
  }
}
