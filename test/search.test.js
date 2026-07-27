import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import sharp from 'sharp'
import { getSearchConfig } from '../src/search/config.js'
import { embedImageDocument, embedQuery } from '../src/search/gemini.js'
import { deleteMediaFilesFromIndex, indexMediaFile } from '../src/search/indexer.js'
import { createMediaStore, fileExtension, mediaTypeForFilename } from '../src/mediaStore.js'
import {
  buildDocumentText,
  isImageFilename,
  payloadMatches,
  pointIdForFilename,
  prepareImageForEmbedding,
  readIndexedMedia,
  readIndexedMediaFile,
  safeMediaFilename,
} from '../src/search/media.js'
import {
  createSearchHandler,
  isInternalRequest,
  parseExcludedFilenames,
  parseLimit,
  shouldUseQueryCache,
} from '../src/search/server.js'

const createTempMediaStore = async (directory) => {
  const dbPath = path.join(directory, 'kaatis.sqlite')
  const store = createMediaStore(dbPath)

  return {
    dbPath,
    store,
    add: async ({
      filename,
      creator = 'creator',
      modified = '2026-01-01 00:00:00.0000000000',
      discordMessageId = '',
    }) => {
      const stat = await fsp.stat(path.join(directory, filename))
      store.upsertMedia({
        filename,
        creator,
        modified,
        discordMessageId,
        mediaType: mediaTypeForFilename(filename),
        extension: fileExtension(filename),
        fileSize: stat.size,
        fileMtimeMs: Math.trunc(stat.mtimeMs),
      })
    },
  }
}

const createTinyPng = (filePath, background = '#ffffff') => sharp({
  create: {
    width: 2,
    height: 2,
    channels: 3,
    background,
  },
}).png().toFile(filePath)

const queryFilterValue = (request, key) => (
  request.filter?.must?.find((condition) => condition.key === key)?.match.value
)

const groupsForPoints = (points) => ({
  groups: points.map((point) => ({ hits: [point] })),
})

test('isImageFilename accepts image formats and rejects videos', () => {
  assert.equal(isImageFilename('meme.PNG'), true)
  assert.equal(isImageFilename('meme.webp'), true)
  assert.equal(isImageFilename('meme.mp4'), false)
})

test('safeMediaFilename rejects path traversal candidates', () => {
  assert.equal(safeMediaFilename('meme.png'), 'meme.png')
  assert.equal(safeMediaFilename('../meme.png'), '')
  assert.equal(safeMediaFilename('folder/meme.png'), '')
})

test('pointIdForFilename returns stable UUID-shaped ids', () => {
  const id = pointIdForFilename('aanet.png')

  assert.equal(id, pointIdForFilename('aanet.png'))
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('readIndexedMedia filters missing files and non-images', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-search-'))
  await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: '#ff00ff',
    },
  }).png().toFile(path.join(directory, 'meme.png'))
  await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: '#00ffff',
    },
  }).png().toFile(path.join(directory, 'unindexed.png'))
  await fsp.writeFile(path.join(directory, 'zero.jpg'), '')
  const { dbPath, store } = await createTempMediaStore(directory)
  await store.upsertMedia({
    filename: 'meme.png',
    creator: 'creator',
    modified: '2026-01-01 00:00:00.0000000000',
    discordMessageId: '',
    mediaType: 'image',
    extension: 'png',
    fileSize: (await fsp.stat(path.join(directory, 'meme.png'))).size,
    fileMtimeMs: 1,
  })
  await store.upsertMedia({
    filename: 'unindexed.png',
    creator: '',
    modified: '2026-01-01 00:00:00.0000000000',
    discordMessageId: '',
    mediaType: 'image',
    extension: 'png',
    fileSize: (await fsp.stat(path.join(directory, 'unindexed.png'))).size,
    fileMtimeMs: 1,
  })
  await store.upsertMedia({
    filename: 'zero.jpg',
    creator: 'creator',
    modified: '2026-01-01 00:00:00.0000000000',
    discordMessageId: '',
    mediaType: 'image',
    extension: 'jpg',
    fileSize: 0,
    fileMtimeMs: 1,
  })
  await store.upsertMedia({
    filename: 'missing.jpg',
    creator: 'creator',
    modified: '2026-01-01 00:00:00.0000000000',
    discordMessageId: '',
    mediaType: 'image',
    extension: 'jpg',
    fileSize: 1,
    fileMtimeMs: 1,
  })
  await store.upsertMedia({
    filename: 'video.mp4',
    creator: 'creator',
    modified: '2026-01-01 00:00:00.0000000000',
    discordMessageId: '',
    mediaType: 'video',
    extension: 'mp4',
    fileSize: 1,
    fileMtimeMs: 1,
  })

  const config = getSearchConfig({
    UPLOAD_DIR: directory,
    MEDIA_DB_PATH: dbPath,
  })
  const media = await readIndexedMedia(config, { store })

  assert.equal(media.length, 2)
  assert.equal(media.some((item) => item.filename === 'meme.png' && item.creator === 'creator'), true)
  assert.equal(media.some((item) => item.filename === 'unindexed.png' && item.creator === ''), true)
  store.close()
})

test('readIndexedMediaFile reads one image with index metadata', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-search-'))
  await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: '#0000ff',
    },
  }).png().toFile(path.join(directory, 'uusi.png'))
  const { dbPath, store, add } = await createTempMediaStore(directory)
  await add({
    filename: 'uusi.png',
    creator: 'uploader',
    discordMessageId: '123',
  })

  const config = getSearchConfig({
    UPLOAD_DIR: directory,
    MEDIA_DB_PATH: dbPath,
  })
  const media = await readIndexedMediaFile({ config, store, filename: 'uusi.png' })

  assert.equal(media.filename, 'uusi.png')
  assert.equal(media.creator, 'uploader')
  assert.equal(media.discordMessageId, '123')
  assert.equal(await readIndexedMediaFile({ config, store, filename: '../uusi.png' }), null)
  assert.equal(await readIndexedMediaFile({ config, store, filename: 'uusi.mp4' }), null)
  store.close()
})

test('indexMediaFile upserts one changed image', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-search-'))
  await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: '#00ff00',
    },
  }).png().toFile(path.join(directory, 'uusi.png'))
  const { dbPath, store, add } = await createTempMediaStore(directory)
  await add({
    filename: 'uusi.png',
    creator: 'uploader',
    discordMessageId: '123',
  })

  const config = getSearchConfig({
    UPLOAD_DIR: directory,
    MEDIA_DB_PATH: dbPath,
    QDRANT_COLLECTION: 'test_collection',
  })
  let upsertedPoint
  const result = await indexMediaFile({
    filename: 'uusi.png',
    config,
    logger: { log: () => {} },
    ai: {
      models: {
        embedContent: async () => ({ embeddings: [{ values: [0.1, 0.2, 0.3] }] }),
      },
    },
    client: {
      collectionExists: async () => ({ exists: true }),
      getCollection: async () => ({
        payload_schema: {
          filename: {},
          mediaType: {},
          pointKind: {},
          modality: {},
        },
      }),
      retrieve: async () => [],
      upsert: async (collectionName, request) => {
        assert.equal(collectionName, 'test_collection')
        const [point] = request.points
        upsertedPoint = point
      },
    },
  })

  assert.equal(result.status, 'indexed')
  assert.equal(result.filename, 'uusi.png')
  assert.equal(upsertedPoint.payload.filename, 'uusi.png')
  store.close()
})

test('deleteMediaFilesFromIndex deletes media points by filename', async () => {
  const config = getSearchConfig({
    QDRANT_COLLECTION: 'test_collection',
    SEARCH_QDRANT_BATCH_SIZE: '2',
  })
  const deletedBatches = []
  const result = await deleteMediaFilesFromIndex({
    filenames: ['uusi.png', 'video.mp4', '../nope.png'],
    config,
    logger: { log: () => {} },
    client: {
      collectionExists: async () => ({ exists: true }),
      scroll: async () => ({
        points: [
          {
            id: pointIdForFilename('uusi.png'),
            payload: { filename: 'uusi.png' },
          },
          {
            id: pointIdForFilename('video.mp4'),
            payload: { filename: 'video.mp4' },
          },
        ],
        next_page_offset: null,
      }),
      delete: async (collectionName, request) => {
        assert.equal(collectionName, 'test_collection')
        deletedBatches.push(request.points)
      },
    },
  })

  assert.equal(result.status, 'deleted')
  assert.equal(result.deleted, 2)
  assert.deepEqual(result.filenames, ['uusi.png', 'video.mp4'])
  assert.deepEqual(deletedBatches, [[
    pointIdForFilename('uusi.png'),
    pointIdForFilename('video.mp4'),
  ]])
})

test('prepareImageForEmbedding converts unsupported images in memory', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-search-'))
  const filePath = path.join(directory, 'meme.webp')
  await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: '#00ff00',
    },
  }).webp().toFile(filePath)

  const media = {
    filePath,
    mimeType: 'image/webp',
    fileSize: (await fsp.stat(filePath)).size,
  }
  const config = getSearchConfig({ SEARCH_CONVERT_IMAGE_BYTES: '4000000' })
  const prepared = await prepareImageForEmbedding(media, config)

  assert.equal(prepared.mimeType, 'image/jpeg')
  assert.equal(prepared.converted, true)
  assert.ok(prepared.data.length > 0)
})

test('payloadMatches checks checksum, source text, model, and dimensions', () => {
  const config = getSearchConfig({
    GEMINI_EMBED_MODEL: 'gemini-embedding-2',
    GEMINI_EMBED_DIMS: '768',
  })
  const media = { filename: 'meme.png', name: 'meme', creator: 'creator', modified: 'today' }
  const sourceTextHash = 'hash'
  const payload = {
    checksum: 'checksum',
    sourceTextHash,
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    embeddingInputVersion: config.embeddingInputVersion,
  }

  assert.equal(payloadMatches({
    payload,
    checksum: 'checksum',
    sourceTextHash,
    config,
  }), true)
  assert.equal(buildDocumentText(media).includes('title: meme'), true)
  assert.equal(payloadMatches({
    payload,
    checksum: 'different',
    sourceTextHash,
    config,
  }), false)
})

test('parseLimit clamps invalid and excessive values', () => {
  const config = getSearchConfig({
    SEARCH_DEFAULT_LIMIT: '30',
    SEARCH_MAX_LIMIT: '100',
    SEARCH_MIN_SCORE: '0.4',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
  })

  assert.equal(parseLimit({ value: '', config }), 30)
  assert.equal(parseLimit({ value: '-1', config }), 30)
  assert.equal(parseLimit({ value: '999', config }), 100)
})

test('shouldUseQueryCache treats cache=0 style values as disabled', () => {
  assert.equal(shouldUseQueryCache(null), true)
  assert.equal(shouldUseQueryCache('1'), true)
  assert.equal(shouldUseQueryCache('0'), false)
  assert.equal(shouldUseQueryCache('false'), false)
  assert.equal(shouldUseQueryCache('off'), false)
})

test('isInternalRequest requires the configured token header', () => {
  const config = getSearchConfig({ SEARCH_INTERNAL_TOKEN: 'salaisuus' })

  assert.equal(isInternalRequest({
    config,
    request: { headers: { 'x-kaatis-internal-token': 'salaisuus' } },
  }), true)
  assert.equal(isInternalRequest({
    config,
    request: { headers: { 'x-kaatis-internal-token': 'väärä' } },
  }), false)
  assert.equal(isInternalRequest({
    config: getSearchConfig({}),
    request: { headers: { 'x-kaatis-internal-token': 'salaisuus' } },
  }), false)
})

test('parseExcludedFilenames parses comma-separated filenames', () => {
  assert.deepEqual(
    [...parseExcludedFilenames('eka.png, toka.jpg,, ')],
    ['eka.png', 'toka.jpg'],
  )
})

test('search API embeds the query and serializes Qdrant payloads', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-search-'))
  await createTinyPng(path.join(directory, 'sauna-cat.png'))
  const { dbPath, store, add } = await createTempMediaStore(directory)
  await add({
    filename: 'sauna-cat.png',
    creator: 'matti',
    modified: '2026-01-01',
  })
  const config = getSearchConfig({
    MEDIA_DB_PATH: dbPath,
    SEARCH_DEFAULT_LIMIT: '30',
    SEARCH_MAX_LIMIT: '100',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
  })
  const handler = createSearchHandler({
    config,
    ai: {},
    embedQueryFn: async ({ query }) => {
      assert.equal(query, 'sauna cat')
      return [0.1, 0.2, 0.3]
    },
    client: {
      queryGroups: async (collectionName, request) => {
        assert.equal(collectionName, 'kaatis_images')
        assert.deepEqual(request.query, [0.1, 0.2, 0.3])
        assert.equal(request.limit, 10)
        if (queryFilterValue(request, 'mediaType') !== 'image') {
          return groupsForPoints([])
        }
        assert.equal(request.score_threshold, 0.4)
        return groupsForPoints([{
          score: 0.98,
          payload: {
            filename: 'sauna-cat.png',
            url: '/sauna-cat.png',
            name: 'sauna cat',
            creator: 'matti',
            modified: '2026-01-01',
          },
        }])
      },
    },
    store,
  })
  let statusCode
  let body
  await handler({
    method: 'GET',
    url: '/api/search?q=sauna%20cat&limit=5',
    headers: { host: 'localhost' },
  }, {
    writeHead: (status) => {
      statusCode = status
    },
    end: (data) => {
      body = JSON.parse(data)
    },
  })

  assert.equal(statusCode, 200)
  assert.equal(body.query, 'sauna cat')
  assert.equal(body.count, 1)
  assert.equal(body.results[0].filename, 'sauna-cat.png')
  assert.equal(body.results[0].score, 1)
  assert.equal(body.results[0].similarityScore, 0.98)
  store.close()
})

test('search API cache=0 bypasses the query embedding cache only for internal requests', async () => {
  const config = getSearchConfig({
    SEARCH_DEFAULT_LIMIT: '30',
    SEARCH_MAX_LIMIT: '100',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
    SEARCH_INTERNAL_TOKEN: 'salaisuus',
  })
  let embedCalls = 0
  const handler = createSearchHandler({
    config,
    ai: {},
    embedQueryFn: async () => {
      embedCalls += 1
      return [embedCalls, 0, 0]
    },
    client: {
      queryGroups: async () => groupsForPoints([]),
    },
  })

  const request = {
    method: 'GET',
    url: '/api/search?q=sauna%20cat&limit=5&cache=0',
    headers: { host: 'localhost', 'x-kaatis-internal-token': 'salaisuus' },
  }
  const response = {
    writeHead: () => {},
    end: () => {},
  }

  await handler(request, response)
  await handler(request, response)

  assert.equal(embedCalls, 2)
})

test('search API ignores public cache=0 requests', async () => {
  const config = getSearchConfig({
    SEARCH_DEFAULT_LIMIT: '30',
    SEARCH_MAX_LIMIT: '100',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
    SEARCH_INTERNAL_TOKEN: 'salaisuus',
  })
  let embedCalls = 0
  const handler = createSearchHandler({
    config,
    ai: {},
    embedQueryFn: async () => {
      embedCalls += 1
      return [embedCalls, 0, 0]
    },
    client: {
      queryGroups: async () => groupsForPoints([]),
    },
  })

  const request = {
    method: 'GET',
    url: '/api/search?q=sauna%20cat&limit=5&cache=0',
    headers: { host: 'localhost', 'x-forwarded-for': '203.0.113.10' },
  }
  const response = {
    writeHead: () => {},
    end: () => {},
  }

  await handler(request, response)
  await handler(request, response)

  assert.equal(embedCalls, 1)
})

test('search API rate limits public search requests', async () => {
  const config = getSearchConfig({
    SEARCH_DEFAULT_LIMIT: '30',
    SEARCH_MAX_LIMIT: '100',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
    SEARCH_RATE_LIMIT_WINDOW_MS: '60000',
    SEARCH_RATE_LIMIT_MAX: '1',
    SEARCH_GLOBAL_RATE_LIMIT_MAX: '100',
  })
  const handler = createSearchHandler({
    config,
    ai: {},
    embedQueryFn: async () => [0.1, 0.2, 0.3],
    client: {
      queryGroups: async () => groupsForPoints([]),
    },
  })
  const statuses = []
  const response = {
    writeHead: (status) => {
      statuses.push(status)
    },
    end: () => {},
  }
  const request = {
    method: 'GET',
    url: '/api/search?q=sauna%20cat',
    headers: { host: 'localhost', 'x-forwarded-for': '203.0.113.10' },
  }

  await handler(request, response)
  await handler(request, response)

  assert.deepEqual(statuses, [200, 429])
})

test('search API has a global public search rate limit', async () => {
  const config = getSearchConfig({
    SEARCH_DEFAULT_LIMIT: '30',
    SEARCH_MAX_LIMIT: '100',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
    SEARCH_RATE_LIMIT_WINDOW_MS: '60000',
    SEARCH_RATE_LIMIT_MAX: '100',
    SEARCH_GLOBAL_RATE_LIMIT_MAX: '1',
  })
  const handler = createSearchHandler({
    config,
    ai: {},
    embedQueryFn: async () => [0.1, 0.2, 0.3],
    client: {
      queryGroups: async () => groupsForPoints([]),
    },
  })
  const statuses = []
  const response = {
    writeHead: (status) => {
      statuses.push(status)
    },
    end: () => {},
  }

  await handler({
    method: 'GET',
    url: '/api/search?q=sauna%20cat',
    headers: { host: 'localhost', 'x-forwarded-for': '203.0.113.10' },
  }, response)
  await handler({
    method: 'GET',
    url: '/api/search?q=sauna%20cat',
    headers: { host: 'localhost', 'x-forwarded-for': '203.0.113.11' },
  }, response)

  assert.deepEqual(statuses, [200, 429])
})

test('search API excludes requested filenames from results', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-search-'))
  await createTinyPng(path.join(directory, 'already-used.png'))
  await createTinyPng(path.join(directory, 'fresh.png'))
  const { dbPath, store, add } = await createTempMediaStore(directory)
  await add({ filename: 'already-used.png' })
  await add({ filename: 'fresh.png' })
  const config = getSearchConfig({
    MEDIA_DB_PATH: dbPath,
    SEARCH_DEFAULT_LIMIT: '30',
    SEARCH_MAX_LIMIT: '100',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
  })
  const handler = createSearchHandler({
    config,
    ai: {},
    embedQueryFn: async () => [0.1, 0.2, 0.3],
    client: {
      queryGroups: async (collectionName, request) => {
        assert.equal(request.limit, 2)
        assert.deepEqual(request.filter.must_not, [{
          key: 'filename',
          match: { any: ['already-used.png'] },
        }])
        if (queryFilterValue(request, 'mediaType') !== 'image') {
          return groupsForPoints([])
        }
        return groupsForPoints([
          { score: 0.9, payload: { filename: 'fresh.png', url: '/fresh.png' } },
        ])
      },
    },
    store,
  })
  let body
  await handler({
    method: 'GET',
    url: '/api/search?q=sauna%20cat&limit=1&exclude=already-used.png',
    headers: { host: 'localhost' },
  }, {
    writeHead: () => {},
    end: (data) => {
      body = JSON.parse(data)
    },
  })

  assert.equal(body.count, 1)
  assert.equal(body.results[0].filename, 'fresh.png')
  store.close()
})

test('index API requires an internal token', async () => {
  const config = getSearchConfig({
    SEARCH_INTERNAL_TOKEN: 'salaisuus',
  })
  let called = false
  const handler = createSearchHandler({
    config,
    indexMediaFileFn: async () => {
      called = true
    },
  })
  let statusCode
  const request = Readable.from([JSON.stringify({ filename: 'uusi.png' })])
  request.method = 'POST'
  request.url = '/api/index'
  request.headers = { host: 'localhost' }

  await handler(request, {
    writeHead: (status) => {
      statusCode = status
    },
    end: () => {},
  })

  assert.equal(statusCode, 403)
  assert.equal(called, false)
})

test('index API indexes one filename for internal requests', async () => {
  const config = getSearchConfig({
    SEARCH_INTERNAL_TOKEN: 'salaisuus',
  })
  const handler = createSearchHandler({
    config,
    indexMediaFileFn: async ({ filename }) => ({
      status: 'indexed',
      filename,
      indexed: true,
      skipped: false,
    }),
  })
  let statusCode
  let body
  const request = Readable.from([JSON.stringify({ filename: 'uusi.png' })])
  request.method = 'POST'
  request.url = '/api/index'
  request.headers = {
    host: 'localhost',
    'x-kaatis-internal-token': 'salaisuus',
  }

  await handler(request, {
    writeHead: (status) => {
      statusCode = status
    },
    end: (data) => {
      body = JSON.parse(data)
    },
  })

  assert.equal(statusCode, 200)
  assert.equal(body.status, 'indexed')
  assert.equal(body.filename, 'uusi.png')
})

test('index API deletes filenames for internal requests', async () => {
  const config = getSearchConfig({
    SEARCH_INTERNAL_TOKEN: 'salaisuus',
  })
  let requestedFilenames
  const handler = createSearchHandler({
    config,
    deleteMediaFilesFromIndexFn: async ({ filenames }) => {
      requestedFilenames = filenames
      return {
        status: 'deleted',
        deleted: filenames.length,
        filenames,
      }
    },
  })
  let statusCode
  let body
  const request = Readable.from([JSON.stringify({ filenames: ['eka.png', 'toka.jpg'] })])
  request.method = 'DELETE'
  request.url = '/api/index'
  request.headers = {
    host: 'localhost',
    'x-kaatis-internal-token': 'salaisuus',
  }

  await handler(request, {
    writeHead: (status) => {
      statusCode = status
    },
    end: (data) => {
      body = JSON.parse(data)
    },
  })

  assert.equal(statusCode, 200)
  assert.deepEqual(requestedFilenames, ['eka.png', 'toka.jpg'])
  assert.equal(body.deleted, 2)
})

test('similar API queries by an indexed filename vector', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-search-'))
  await createTinyPng(path.join(directory, 'source.png'))
  await createTinyPng(path.join(directory, 'neighbor.png'))
  const { dbPath, store, add } = await createTempMediaStore(directory)
  await add({ filename: 'source.png' })
  await add({ filename: 'neighbor.png' })
  const config = getSearchConfig({
    MEDIA_DB_PATH: dbPath,
    SEARCH_DEFAULT_LIMIT: '30',
    SEARCH_MAX_LIMIT: '100',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
  })
  const sourceId = pointIdForFilename('source.png')
  const handler = createSearchHandler({
    config,
    ai: {},
    client: {
      retrieve: async (collectionName, request) => {
        assert.equal(collectionName, 'kaatis_images')
        assert.deepEqual(request.ids, [sourceId])
        return [{
          id: sourceId,
          vector: [0.1, 0.2, 0.3],
          payload: { filename: 'source.png' },
        }]
      },
      queryGroups: async (collectionName, request) => {
        assert.equal(collectionName, 'kaatis_images')
        assert.deepEqual(request.query, [0.1, 0.2, 0.3])
        assert.equal(request.limit, 6)
        assert.deepEqual(request.filter.must_not, [{
          key: 'filename',
          match: { any: ['source.png'] },
        }])
        if (queryFilterValue(request, 'mediaType') !== 'image') {
          return groupsForPoints([])
        }
        return groupsForPoints([
          { score: 0.9, payload: { filename: 'neighbor.png', url: '/neighbor.png' } },
        ])
      },
    },
    store,
  })
  let statusCode
  let body
  await handler({
    method: 'GET',
    url: '/api/similar?filename=source.png&limit=3',
    headers: { host: 'localhost' },
  }, {
    writeHead: (status) => {
      statusCode = status
    },
    end: (data) => {
      body = JSON.parse(data)
    },
  })

  assert.equal(statusCode, 200)
  assert.equal(body.filename, 'source.png')
  assert.equal(body.count, 1)
  assert.equal(body.results[0].filename, 'neighbor.png')
  store.close()
})

test('Gemini document embedding sends one multimodal content', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-search-'))
  const filePath = path.join(directory, 'meme.png')
  await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: '#ff0000',
    },
  }).png().toFile(filePath)

  let request
  const ai = {
    models: {
      embedContent: async (params) => {
        request = params
        return { embeddings: [{ values: [0.1, 0.2, 0.3] }] }
      },
    },
  }
  const config = getSearchConfig({})
  const result = await embedImageDocument({
    ai,
    config,
    media: {
      filename: 'meme.png',
      name: 'meme',
      creator: 'creator',
      modified: '2026-01-01',
      filePath,
      mimeType: 'image/png',
      fileSize: (await fsp.stat(filePath)).size,
    },
  })

  assert.deepEqual(result.vector, [0.1, 0.2, 0.3])
  assert.equal(request.contents.parts.length, 2)
  assert.equal(request.contents.parts[0].text.includes('title: meme'), true)
  assert.equal(request.contents.parts[1].inlineData.mimeType, 'image/png')
})

test('Gemini query embedding sends raw query text', async () => {
  let request
  const ai = {
    models: {
      embedContent: async (params) => {
        request = params
        return { embeddings: [{ values: [0.4, 0.5, 0.6] }] }
      },
    },
  }
  const config = getSearchConfig({})
  const vector = await embedQuery({ ai, config, query: 'sauna cat' })

  assert.deepEqual(vector, [0.4, 0.5, 0.6])
  assert.equal(request.contents, 'sauna cat')
})
