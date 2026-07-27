import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ensureCollection,
  mergeRankedMediaPoints,
  mergeVideoComponentPoints,
  normalizedRrfScore,
  queryBalancedMediaPoints,
  queryGroupedPoints,
} from '../src/search/qdrant.js'

test('grouped query returns the best point from each filename', async () => {
  const calls = []
  const client = {
    queryGroups: async (...args) => {
      calls.push(args)
      return {
        groups: [
          { id: 'a.mp4', hits: [{ id: 'a-voice', score: 0.9 }] },
          { id: 'b.jpg', hits: [{ id: 'b-image', score: 0.8 }] },
        ],
      }
    },
  }
  const points = await queryGroupedPoints({
    client,
    collectionName: 'media',
    vector: [1, 2],
    limit: 2,
    scoreThreshold: 0.4,
  })

  assert.deepEqual(points.map((point) => point.id), ['a-voice', 'b-image'])
  assert.equal(calls[0][0], 'media')
  assert.equal(calls[0][1].group_by, 'filename')
  assert.equal(calls[0][1].group_size, 1)
})

const point = ({ id, score, filename, mediaType, pointKind, modality, start, end }) => ({
  id,
  score,
  payload: {
    filename,
    mediaType,
    pointKind,
    modality,
    startSeconds: start,
    endSeconds: end,
  },
})

const filterValue = (query, key) => (
  query.filter.must.find((condition) => condition.key === key)?.match.value
)

test('balanced query admits videos by modality threshold and interleaves them with images', async () => {
  const calls = []
  const client = {
    queryGroups: async (collection, query) => {
      calls.push({ collection, query })
      const mediaType = filterValue(query, 'mediaType')
      const modality = filterValue(query, 'modality')

      if (mediaType === 'image') {
        return {
          groups: [
            { hits: [point({
              id: 'image-1',
              score: 0.61,
              filename: 'image-1.jpg',
              mediaType: 'image',
            })] },
            { hits: [point({
              id: 'image-2',
              score: 0.52,
              filename: 'image-2.jpg',
              mediaType: 'image',
            })] },
          ],
        }
      }
      if (modality === 'audio') {
        return {
          groups: [
            { hits: [point({
              id: 'video-1-audio',
              score: 0.81,
              filename: 'video-1.mp4',
              mediaType: 'video',
              pointKind: 'component',
              modality: 'audio',
              start: 150,
              end: 300,
            })] },
            { hits: [point({
              id: 'irrelevant-audio',
              score: 0.577,
              filename: 'irrelevant.mp4',
              mediaType: 'video',
              pointKind: 'component',
              modality: 'audio',
            })] },
          ],
        }
      }
      return {
        groups: [
          { hits: [point({
            id: 'video-2-storyboard',
            score: 0.64,
            filename: 'video-2.mp4',
            mediaType: 'video',
            pointKind: 'component',
            modality: 'storyboard',
            start: 0,
            end: 42,
          })] },
          { hits: [point({
            id: 'irrelevant-storyboard',
            score: 0.413,
            filename: 'irrelevant.mp4',
            mediaType: 'video',
            pointKind: 'component',
            modality: 'storyboard',
          })] },
        ],
      }
    },
  }

  const points = await queryBalancedMediaPoints({
    client,
    collectionName: 'media',
    vector: [1, 2],
    limit: 4,
    scoreThreshold: 0.4,
    excludedFilenames: new Set(['excluded.jpg']),
  })

  assert.deepEqual(points.map((item) => item.id), [
    'image-1',
    'video-1-audio',
    'image-2',
    'video-2-storyboard',
  ])
  assert.deepEqual(points.map((item) => item.score), [
    1,
    1,
    normalizedRrfScore(2),
    normalizedRrfScore(2),
  ])
  assert.equal(points[1].similarityScore, 0.81)
  assert.equal(points[1].payload.modality, 'audio')
  assert.equal(points[1].payload.startSeconds, 150)
  assert.equal(points[3].payload.modality, 'storyboard')

  assert.equal(calls.length, 3)
  assert.equal(calls.some(({ query }) => filterValue(query, 'pointKind') === 'root'), false)
  const audioCall = calls.find(({ query }) => filterValue(query, 'modality') === 'audio')
  const storyboardCall = calls.find(({ query }) => (
    filterValue(query, 'modality') === 'storyboard'
  ))
  assert.equal(audioCall.query.score_threshold, 0.6)
  assert.equal(storyboardCall.query.score_threshold, 0.45)
  for (const { query } of [audioCall, storyboardCall]) {
    assert.equal(filterValue(query, 'pointKind'), 'component')
  }
  calls.forEach(({ query }) => {
    assert.deepEqual(query.filter.must_not, [{
      key: 'filename',
      match: { any: ['excluded.jpg'] },
    }])
  })
})

test('video component merge rejects roni-like weak matches', () => {
  const points = mergeVideoComponentPoints({
    audioPoints: [
      point({
        id: 'weak-audio',
        score: 0.577,
        filename: 'ropontti.mp4',
        mediaType: 'video',
        pointKind: 'component',
        modality: 'audio',
      }),
      point({
        id: 'good-audio',
        score: 0.67,
        filename: 'good.mp4',
        mediaType: 'video',
        pointKind: 'component',
        modality: 'audio',
      }),
    ],
    storyboardPoints: [
      point({
        id: 'weak-storyboard',
        score: 0.413,
        filename: 'rusan-shelli.mov',
        mediaType: 'video',
        pointKind: 'component',
        modality: 'storyboard',
      }),
    ],
    audioThreshold: 0.6,
    storyboardThreshold: 0.45,
    limit: 10,
  })

  assert.deepEqual(points.map((item) => item.id), ['good-audio'])
  assert.equal(points[0].similarityScore, 0.67)
})

test('balanced merge fills the result list when only one media type has matches', () => {
  const imagePoints = [
    point({ id: 'a', score: 0.8, filename: 'a.jpg', mediaType: 'image' }),
    point({ id: 'b', score: 0.7, filename: 'b.jpg', mediaType: 'image' }),
    point({ id: 'c', score: 0.6, filename: 'c.jpg', mediaType: 'image' }),
  ]
  const points = mergeRankedMediaPoints({
    imagePoints,
    videoPoints: [],
    limit: 2,
  })

  assert.deepEqual(points.map((item) => item.id), ['a', 'b'])
  assert.equal(points[0].score, 1)
  assert.equal(points[1].score, normalizedRrfScore(2))
})

test('collection setup creates keyword indexes used by balanced search', async () => {
  const indexes = []
  const client = {
    collectionExists: async () => ({ exists: true }),
    getCollection: async () => ({ payload_schema: { filename: {} } }),
    createPayloadIndex: async (collection, options) => {
      indexes.push({ collection, options })
    },
  }

  await ensureCollection({
    client,
    config: {
      qdrantCollection: 'media',
      embeddingDimensions: 768,
    },
  })

  assert.deepEqual(indexes.map(({ options }) => options.field_name), [
    'mediaType',
    'pointKind',
    'modality',
  ])
})
