import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getSearchConfig } from '../src/search/config.js'
import {
  averageNormalizedVectors,
  videoPointsFromComponents,
} from '../src/search/indexer.js'
import {
  downloadBatchResponses,
  preparedVideoBatchItem,
} from '../src/search/batchIndexer.js'
import { audioSegmentsForDuration } from '../src/search/video.js'

const config = getSearchConfig({
  GEMINI_EMBED_DIMS: '2',
  SEARCH_VIDEO_MAX_DURATION_SECONDS: '300',
})

const media = {
  id: '00000000-0000-5000-8000-000000000001',
  filename: 'video.mp4',
  mediaType: 'video',
  extension: 'mp4',
  url: '/video.mp4',
  name: 'video',
  creator: 'tester',
  modified: '2026-07-26T00:00:00.000Z',
  discordMessageId: '1',
  fileSize: 123,
  fileMtimeMs: 456,
}

test('audio uses one segment through 180 seconds', () => {
  assert.deepEqual(audioSegmentsForDuration(180), [{
    index: 0,
    startSeconds: 0,
    endSeconds: 180,
  }])
})

test('five minute audio uses two overlapping segments', () => {
  assert.deepEqual(audioSegmentsForDuration(600), [
    { index: 0, startSeconds: 0, endSeconds: 155 },
    { index: 1, startSeconds: 150, endSeconds: 300 },
  ])
})

test('component vectors are normalized before averaging', () => {
  const vector = averageNormalizedVectors([[3, 0], [0, 4]])
  assert.ok(Math.abs(vector[0] - Math.SQRT1_2) < 1e-12)
  assert.ok(Math.abs(vector[1] - Math.SQRT1_2) < 1e-12)
})

test('video points include a stable root and component metadata', () => {
  const points = videoPointsFromComponents({
    media,
    checksum: 'checksum',
    sourceTextHash: 'text-hash',
    components: [
      {
        kind: 'storyboard',
        segmentIndex: 0,
        startSeconds: 0,
        endSeconds: 300,
        vector: [1, 0],
      },
      {
        kind: 'audio',
        segmentIndex: 0,
        startSeconds: 0,
        endSeconds: 155,
        vector: [0, 1],
      },
    ],
    durationSeconds: 400,
    indexedDurationSeconds: 300,
    truncated: true,
    config,
  })

  assert.equal(points.length, 3)
  assert.equal(points[0].id, media.id)
  assert.equal(points[0].payload.pointKind, 'root')
  assert.equal(points[0].payload.embeddingTruncated, true)
  assert.equal(points[2].payload.modality, 'audio')
  assert.equal(points[2].payload.endSeconds, 155)
})

test('batch item creates one storyboard and one request per audio segment', () => {
  const item = preparedVideoBatchItem({
    media,
    checksum: 'checksum',
    sourceTextHash: 'text-hash',
    prepared: {
      durationSeconds: 400,
      indexedDurationSeconds: 300,
      truncated: true,
      storyboard: Array.from({ length: 6 }, () => ({
        data: Buffer.from('jpeg'),
        mimeType: 'image/jpeg',
      })),
      audio: [{
        index: 0,
        startSeconds: 0,
        endSeconds: 155,
        data: Buffer.from('mp3'),
        mimeType: 'audio/mpeg',
      }],
    },
    config,
  })

  assert.equal(item.manifest.requests.length, 2)
  assert.equal(item.lines.length, 2)
  const storyboardRequest = JSON.parse(item.lines[0])
  assert.ok(storyboardRequest.metadata.key)
  assert.equal(storyboardRequest.request.content.parts.length, 7)
  assert.equal(storyboardRequest.request.outputDimensionality, 2)
})

test('batch responses are downloaded to disk and matched by metadata', async () => {
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaatis-test-'))
  const testConfig = { ...config, videoTempDirectory: temporaryDirectory }
  const job = {
    name: 'batches/test',
    outputFileName: 'files/result',
    items: [{
      requests: [{ key: 'storyboard-key' }],
    }],
  }
  const ai = {
    files: {
      download: async ({ file, downloadPath }) => {
        assert.equal(file, 'files/result')
        await fsp.writeFile(downloadPath, `${JSON.stringify({
          metadata: { key: 'storyboard-key' },
          response: { embedding: { values: [0.25, 0.75] } },
        })}\n`)
      },
    },
  }

  try {
    const responses = await downloadBatchResponses({
      ai,
      job,
      config: testConfig,
    })
    assert.deepEqual(responses.vectors.get('storyboard-key'), [0.25, 0.75])
    assert.deepEqual(await fsp.readdir(temporaryDirectory), [])
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true })
  }
})
