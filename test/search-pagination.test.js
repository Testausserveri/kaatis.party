import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchContextFingerprint,
} from '../src/search/cursor.js'
import {
  createMediaSearch,
  SemanticSearchUnavailableError,
} from '../apps/api/src/search.ts'

const mediaRow = (filename) => ({
  filename,
  title: filename,
  creator: '',
  modified: '2026-01-01T00:00:00.000Z',
  media_type: 'image',
  extension: 'png',
  file_size: 1,
  width: 1,
  height: 1,
  duration_ms: 0,
  dominant_color: '#171717',
  preview_status: 'pending',
  preview_version: 0,
  checksum: '',
})

const createSearch = ({ semanticSearch, count = 1100 }) => {
  const rows = Array.from(
    { length: count },
    (_, index) => mediaRow(`item-${String(index).padStart(4, '0')}.png`),
  )
  const sourceLimits = []
  const store = {
    searchMedia: (_query, limit) => {
      sourceLimits.push(limit)
      return rows.slice(0, limit)
    },
    mediaByFilenames: () => new Map(),
    mediaByFilename: () => null,
  }
  const search = createMediaSearch({
    config: {
      publicBaseUrl: '/',
      maxSearchResults: 1000,
    },
    store,
    logger: { error: () => {} },
    client: {},
    semanticSearch,
  })
  return { search, sourceLimits }
}

test('search cursor is bound to its complete search context', () => {
  const fingerprint = searchContextFingerprint({
    query: 'testausserveri',
    type: 'image',
    excludedFilenames: new Set(['b.png', 'a.png']),
  })
  const cursor = encodeSearchCursor({
    fingerprint,
    offset: 80,
    mode: 'semantic',
  })

  assert.deepEqual(decodeSearchCursor({
    value: cursor,
    fingerprint,
    maxOffset: 1000,
  }), {
    offset: 80,
    mode: 'semantic',
  })
  assert.throws(() => decodeSearchCursor({
    value: cursor,
    fingerprint: searchContextFingerprint({ query: 'toinen' }),
    maxOffset: 1000,
  }), /invalid_cursor/)
})

test('search cursor rejects malformed and out-of-range offsets', () => {
  const fingerprint = searchContextFingerprint({ query: 'testausserveri' })
  for (const value of [
    'not-base64-json',
    encodeSearchCursor({ fingerprint, offset: 0, mode: 'semantic' }),
    encodeSearchCursor({ fingerprint, offset: 1000, mode: 'semantic' }),
    encodeSearchCursor({ fingerprint, offset: 80, mode: 'auto' }),
  ]) {
    assert.throws(() => decodeSearchCursor({
      value,
      fingerprint,
      maxOffset: 1000,
    }), /invalid_cursor/)
  }
})

test('search pages continue without overlap and expand the RRF source prefix', async () => {
  const { search, sourceLimits } = createSearch({
    semanticSearch: async () => ({ image: [], video: [] }),
  })
  const first = await search.search({ query: 'test', limit: 80 })
  const second = await search.search({
    query: 'test',
    limit: 80,
    offset: 80,
    mode: first.mode,
  })

  assert.equal(first.count, 80)
  assert.equal(first.hasMore, true)
  assert.equal(second.count, 80)
  assert.equal(second.hasMore, true)
  assert.equal(first.results[0].filename, 'item-0000.png')
  assert.equal(second.results[0].filename, 'item-0080.png')
  assert.equal(
    first.results.some((item) => (
      second.results.some((candidate) => candidate.filename === item.filename)
    )),
    false,
  )
  assert.deepEqual(sourceLimits, [160, 320])
})

test('search stops exactly at the configured result depth', async () => {
  const { search } = createSearch({
    semanticSearch: async () => ({ image: [], video: [] }),
  })
  const last = await search.search({
    query: 'test',
    limit: 80,
    offset: 960,
    mode: 'semantic',
  })

  assert.equal(last.count, 40)
  assert.equal(last.results[0].filename, 'item-0960.png')
  assert.equal(last.results.at(-1).filename, 'item-0999.png')
  assert.equal(last.hasMore, false)
})

test('first-page semantic failure locks following pages to lexical search', async () => {
  let semanticCalls = 0
  const { search } = createSearch({
    semanticSearch: async () => {
      semanticCalls += 1
      throw new Error('qdrant unavailable')
    },
  })
  const first = await search.search({ query: 'test', limit: 80 })
  const second = await search.search({
    query: 'test',
    limit: 80,
    offset: 80,
    mode: first.mode,
  })

  assert.equal(first.mode, 'lexical')
  assert.equal(first.degraded, true)
  assert.equal(second.mode, 'lexical')
  assert.equal(second.degraded, true)
  assert.equal(semanticCalls, 1)
})

test('later semantic failure stops pagination instead of changing ranking mode', async () => {
  const { search } = createSearch({
    semanticSearch: async () => {
      throw new Error('qdrant unavailable')
    },
  })

  await assert.rejects(() => search.search({
    query: 'test',
    limit: 80,
    offset: 80,
    mode: 'semantic',
  }), SemanticSearchUnavailableError)
})
