import assert from 'node:assert/strict'
import test from 'node:test'
import { getSearchConfig } from '../src/search/config.js'
import { createSearchHandler } from '../src/search/server.js'

const mediaRows = new Map([
  ['image-1.jpg', {
    filename: 'image-1.jpg',
    media_type: 'image',
    extension: 'jpg',
    modified: '2026-07-27T00:00:00.000Z',
    creator: 'tester',
    file_size: 10,
    file_mtime_ms: 20,
  }],
  ['image-2.jpg', {
    filename: 'image-2.jpg',
    media_type: 'image',
    extension: 'jpg',
    modified: '2026-07-27T00:00:00.000Z',
    creator: 'tester',
    file_size: 10,
    file_mtime_ms: 20,
  }],
  ['video-1.mp4', {
    filename: 'video-1.mp4',
    media_type: 'video',
    extension: 'mp4',
    modified: '2026-07-27T00:00:00.000Z',
    creator: 'tester',
    file_size: 30,
    file_mtime_ms: 40,
  }],
  ['video-2.mp4', {
    filename: 'video-2.mp4',
    media_type: 'video',
    extension: 'mp4',
    modified: '2026-07-27T00:00:00.000Z',
    creator: 'tester',
    file_size: 30,
    file_mtime_ms: 40,
  }],
])

const qdrantPoint = ({
  id,
  filename,
  mediaType,
  pointKind,
  score,
  modality,
  startSeconds,
  endSeconds,
}) => ({
  id,
  score,
  payload: {
    filename,
    mediaType,
    pointKind,
    modality,
    startSeconds,
    endSeconds,
  },
})

const filterValue = (query, key) => (
  query.filter.must.find((condition) => condition.key === key)?.match.value
)

const createClient = () => ({
  retrieve: async () => [{
    id: 'source',
    vector: [1, 2],
    payload: { filename: 'source.jpg', mediaType: 'image' },
  }],
  queryGroups: async (collection, query) => {
    const mediaType = filterValue(query, 'mediaType')
    const modality = filterValue(query, 'modality')
    if (mediaType === 'image') {
      return {
        groups: [
          { hits: [qdrantPoint({
            id: 'stale-image',
            filename: 'stale-image.jpg',
            mediaType: 'image',
            score: 0.7,
          })] },
          { hits: [qdrantPoint({
            id: 'image-1',
            filename: 'image-1.jpg',
            mediaType: 'image',
            score: 0.61,
          })] },
          { hits: [qdrantPoint({
            id: 'image-2',
            filename: 'image-2.jpg',
            mediaType: 'image',
            score: 0.53,
          })] },
        ],
      }
    }
    if (modality === 'audio') {
      return {
        groups: [
          { hits: [qdrantPoint({
            id: 'video-1-audio',
            filename: 'video-1.mp4',
            mediaType: 'video',
            pointKind: 'component',
            score: 0.75,
            modality: 'audio',
            startSeconds: 150,
            endSeconds: 300,
          })] },
        ],
      }
    }
    return {
      groups: [
        { hits: [qdrantPoint({
          id: 'video-2-storyboard',
          filename: 'video-2.mp4',
          mediaType: 'video',
          pointKind: 'component',
          score: 0.64,
          modality: 'storyboard',
          startSeconds: 0,
          endSeconds: 42,
        })] },
      ],
    }
  },
})

const createTestHandler = () => {
  const config = getSearchConfig({
    GEMINI_API_KEY: 'test',
    SEARCH_PERSIST_QUERY_CACHE: 'false',
    SEARCH_DEFAULT_LIMIT: '4',
    SEARCH_MAX_LIMIT: '10',
    SEARCH_MIN_SCORE: '0.4',
  })
  const store = {
    mediaByFilenames: (filenames) => new Map(filenames
      .filter((filename) => mediaRows.has(filename))
      .map((filename) => [filename, mediaRows.get(filename)])),
  }
  return createSearchHandler({
    config,
    client: createClient(),
    store,
    ai: {},
    embedQueryFn: async () => [1, 2],
  })
}

const callHandler = async (handler, url) => {
  let status
  let responseBody
  await handler({
    method: 'GET',
    url,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
  }, {
    writeHead: (value) => {
      status = value
    },
    end: (value) => {
      responseBody = value
    },
  })
  return {
    status,
    body: JSON.parse(responseBody),
  }
}

test('APIs stay balanced after stale Qdrant points are removed during hydration', async () => {
  const handler = createTestHandler()
  for (const path of [
    '/api/search?q=test&limit=4',
    '/api/similar?filename=source.jpg&limit=4',
  ]) {
    const response = await callHandler(handler, path)
    const { body } = response

    assert.equal(response.status, 200)
    assert.deepEqual(body.results.map((result) => result.type), [
      'image',
      'video',
      'image',
      'video',
    ])
    assert.deepEqual(body.results.map((result) => result.score), [
      1,
      1,
      61 / 62,
      61 / 62,
    ])
    assert.equal(body.results[1].similarityScore, 0.75)
    assert.equal(body.results[1].matchedModality, 'audio')
    assert.equal(body.results[1].matchStartSeconds, 150)
    assert.equal(body.results[1].matchEndSeconds, 300)
    assert.equal(body.results[3].matchedModality, 'storyboard')
  }
})
