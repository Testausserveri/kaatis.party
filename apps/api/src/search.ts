import type {
  MediaItem,
  SearchMediaItem,
  SearchResponse,
  SimilarResponse,
} from '@kaatis/contracts'

import {
  createGeminiClient,
  embedQuery,
} from '../../../src/search/gemini.js'
import {
  mediaToApiItem,
} from '../../../src/mediaStore.js'
import {
  pointIdForFilename,
} from '../../../src/search/media.js'
import {
  createQdrantClient,
  querySemanticMediaLists,
} from '../../../src/search/qdrant.js'
import type { ApiConfig } from './config.ts'

interface Point {
  id: string
  score: number
  payload?: {
    filename?: string
    modality?: SearchMediaItem['matchedModality']
    startSeconds?: number
    endSeconds?: number
    embeddingTruncated?: boolean
  }
}

interface Store {
  searchMedia: (query: string, limit: number) => Record<string, unknown>[]
  mediaByFilenames: (filenames: string[]) => Map<string, Record<string, unknown>>
  mediaByFilename: (filename: string) => Record<string, unknown> | null
}

export type SearchMode = 'auto' | 'semantic' | 'lexical'

interface SemanticLists {
  image: SearchMediaItem[]
  video: SearchMediaItem[]
}

interface SearchPage extends Omit<SearchResponse, 'nextCursor'> {
  hasMore: boolean
  mode: Exclude<SearchMode, 'auto'>
}

interface SemanticSearchOptions {
  query: string
  limit: number
  type?: string
  excludedFilenames?: Set<string>
}

export class SemanticSearchUnavailableError extends Error {
  constructor() {
    super('semantic_search_unavailable')
    this.name = 'SemanticSearchUnavailableError'
  }
}

const normalizedRrf = (rank: number, constant = 60) => (
  (constant + 1) / (constant + rank)
)

const pointFilename = (point: Point) => point.payload?.filename || ''

const semanticItem = ({
  point,
  row,
  config,
}: {
  point: Point
  row: Record<string, unknown>
  config: ApiConfig
}): SearchMediaItem => ({
  ...(mediaToApiItem(row, { publicBaseUrl: config.publicBaseUrl }) as MediaItem),
  score: point.score,
  similarityScore: point.score,
  matchedModality: point.payload?.modality || 'image',
  matchStartSeconds: point.payload?.startSeconds,
  matchEndSeconds: point.payload?.endSeconds,
  embeddingTruncated: Boolean(point.payload?.embeddingTruncated),
})

const hydratePoints = ({
  points,
  store,
  config,
  type,
}: {
  points: Point[]
  store: Store
  config: ApiConfig
  type?: string
}) => {
  const filenames = points.map(pointFilename).filter(Boolean)
  const rows = store.mediaByFilenames(filenames)
  return points.flatMap((point) => {
    const filename = pointFilename(point)
    const row = rows.get(filename)
    if (!row || (type && row.media_type !== type)) return []
    return [semanticItem({ point, row, config })]
  })
}

export const mergeRrf = ({
  lists,
  limit,
}: {
  lists: { items: SearchMediaItem[], weight: number }[]
  limit: number
}) => {
  const ranked = new Map<string, {
    item: SearchMediaItem
    score: number
  }>()

  lists.forEach(({ items, weight }) => {
    items.forEach((item, index) => {
      const contribution = weight * normalizedRrf(index + 1)
      const current = ranked.get(item.filename)
      if (!current) {
        ranked.set(item.filename, {
          item,
          score: contribution,
        })
        return
      }
      current.score += contribution
      if (
        item.similarityScore !== undefined
        && (
          current.item.similarityScore === undefined
          || item.similarityScore > current.item.similarityScore
        )
      ) {
        current.item = {
          ...current.item,
          ...item,
        }
      }
    })
  })

  const results = [...ranked.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  const maximum = results[0]?.score || 1

  return results.map(({ item, score }) => ({
    ...item,
    score: score / maximum,
  }))
}

const memoryQueryCache = new Map<string, number[]>()

const createQueryVector = async ({
  query,
  config,
  client,
}: {
  query: string
  config: ApiConfig
  client: ReturnType<typeof createQdrantClient>
}) => {
  const key = [
    config.embeddingModel,
    config.embeddingDimensions,
    config.embeddingInputVersion,
    query.toLocaleLowerCase('fi'),
  ].join(':')
  const memory = memoryQueryCache.get(key)
  if (memory) return memory

  const id = pointIdForFilename(`query:${key}`)
  try {
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
    const points = await client.retrieve(config.qdrantQueryCacheCollection, {
      ids: [id],
      with_payload: true,
      with_vector: true,
    })
    const cached = points[0]
    const cachedVector = cached?.vector
    if (
      Array.isArray(cachedVector)
      && cachedVector.every((value) => typeof value === 'number')
      && cached.payload?.key === key
    ) {
      const vector = cachedVector as number[]
      memoryQueryCache.set(key, vector)
      return vector
    }
  } catch {
    // Persistent cache is an optimization. Search can continue without it.
  }

  const vector = await embedQuery({
    ai: createGeminiClient(config),
    query,
    config,
  })
  memoryQueryCache.set(key, vector)
  while (memoryQueryCache.size > config.queryCacheMaxEntries) {
    const oldest = memoryQueryCache.keys().next().value
    if (oldest) memoryQueryCache.delete(oldest)
  }

  try {
    await client.upsert(config.qdrantQueryCacheCollection, {
      wait: true,
      points: [{
        id,
        vector,
        payload: {
          key,
          query,
          createdAt: new Date().toISOString(),
        },
      }],
    })
  } catch {
    // The result itself is still valid when cache persistence fails.
  }

  return vector
}

export const createMediaSearch = ({
  config,
  store,
  logger,
  client: suppliedClient,
  semanticSearch,
}: {
  config: ApiConfig
  store: Store
  logger: {
    error: (value: unknown, message?: string) => void
  }
  client?: ReturnType<typeof createQdrantClient>
  semanticSearch?: (options: SemanticSearchOptions) => Promise<SemanticLists>
}) => {
  const client = suppliedClient || createQdrantClient(config)

  const loadSemanticLists = semanticSearch || (async ({
    query,
    limit,
    type,
    excludedFilenames = new Set<string>(),
  }: SemanticSearchOptions) => {
    const vector = await createQueryVector({ query, config, client })
    const points = await querySemanticMediaLists({
      client,
      collectionName: config.qdrantCollection,
      vector,
      limit,
      scoreThreshold: config.minSearchScore > 0
        ? config.minSearchScore
        : undefined,
      excludedFilenames,
      videoAudioScoreThreshold: config.videoAudioMinSearchScore,
      videoStoryboardScoreThreshold: config.videoStoryboardMinSearchScore,
    })

    return {
      image: hydratePoints({
        points: points.imagePoints,
        store,
        config,
        type,
      }),
      video: hydratePoints({
        points: points.videoPoints,
        store,
        config,
        type,
      }),
    }
  })

  const search = async ({
    query,
    limit,
    offset = 0,
    maxResults = config.maxSearchResults,
    mode = 'auto',
    type,
    excludedFilenames = new Set<string>(),
  }: {
    query: string
    limit: number
    offset?: number
    maxResults?: number
    mode?: SearchMode
    type?: string
    excludedFilenames?: Set<string>
  }): Promise<SearchPage> => {
    const pageLimit = Math.min(limit, Math.max(0, maxResults - offset))
    const requestedEnd = offset + pageLimit
    const rankingLimit = Math.min(maxResults, requestedEnd + 1)
    const sourceLimit = Math.min(
      maxResults * 2,
      Math.max(limit * 2, requestedEnd * 2),
    )
    const lexical = store.searchMedia(query, sourceLimit)
      .filter((row) => !type || row.media_type === type)
      .filter((row) => !excludedFilenames.has(String(row.filename)))
      .map((row) => ({
        ...(mediaToApiItem(row, {
          publicBaseUrl: config.publicBaseUrl,
        }) as MediaItem),
        score: 0,
      }))

    let semantic: SemanticLists = {
      image: [] as SearchMediaItem[],
      video: [] as SearchMediaItem[],
    }
    let resolvedMode: Exclude<SearchMode, 'auto'> = 'lexical'
    if (mode !== 'lexical') {
      try {
        semantic = await loadSemanticLists({
          query,
          limit: sourceLimit,
          type,
          excludedFilenames,
        })
        resolvedMode = 'semantic'
      } catch (error) {
        logger.error({
          event: 'semantic_search_unavailable',
          query,
          error: error instanceof Error ? error.message : String(error),
        })
        if (mode === 'semantic') throw new SemanticSearchUnavailableError()
      }
    }

    const ranked = mergeRrf({
      lists: [
        { items: lexical, weight: 1.25 },
        { items: semantic.image, weight: 1 },
        { items: semantic.video, weight: 1 },
      ],
      limit: rankingLimit,
    })
    const results = ranked.slice(offset, requestedEnd)

    return {
      query,
      count: results.length,
      degraded: resolvedMode === 'lexical',
      hasMore: requestedEnd < maxResults && ranked.length > requestedEnd,
      mode: resolvedMode,
      results,
    }
  }

  const similar = async ({
    filename,
    limit,
  }: {
    filename: string
    limit: number
  }): Promise<SimilarResponse | null> => {
    const source = store.mediaByFilename(filename)
    if (!source || source.media_type === 'audio') return null
    const id = pointIdForFilename(filename)
    const sourcePoints = await client.retrieve(config.qdrantCollection, {
      ids: [id],
      with_payload: true,
      with_vector: true,
    })
    const vector = sourcePoints[0]?.vector
    if (!Array.isArray(vector)) return null

    const points = await querySemanticMediaLists({
      client,
      collectionName: config.qdrantCollection,
      vector,
      limit: limit * 2,
      scoreThreshold: config.minSearchScore > 0
        ? config.minSearchScore
        : undefined,
      excludedFilenames: new Set([filename]),
      videoAudioScoreThreshold: config.videoAudioMinSearchScore,
      videoStoryboardScoreThreshold: config.videoStoryboardMinSearchScore,
    })
    const image = hydratePoints({
      points: points.imagePoints,
      store,
      config,
    })
    const video = hydratePoints({
      points: points.videoPoints,
      store,
      config,
    })
    const results = mergeRrf({
      lists: [
        { items: image, weight: 1 },
        { items: video, weight: 1 },
      ],
      limit,
    })

    return {
      filename,
      count: results.length,
      results,
    }
  }

  return {
    search,
    similar,
  }
}
