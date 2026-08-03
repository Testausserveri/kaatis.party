import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendUniqueItems,
  createMediaSnapshotCache,
} from '../apps/web/src/mediaCache.ts'

const item = (filename) => ({ filename })

test('media page append preserves order and removes duplicate filenames', () => {
  assert.deepEqual(
    appendUniqueItems(
      [item('a.png'), item('b.png')],
      [item('b.png'), item('c.png'), item('c.png'), item('d.png')],
    ).map((media) => media.filename),
    ['a.png', 'b.png', 'c.png', 'd.png'],
  )
})

test('media cache keeps each query cursor and evicts the oldest snapshot', () => {
  const cache = createMediaSnapshotCache(2)
  cache.set('first', { items: [item('a.png')], cursor: 'cursor-a' })
  cache.set('second', { items: [item('b.png')], cursor: 'cursor-b' })

  assert.equal(cache.get('first').cursor, 'cursor-a')
  assert.equal(cache.get('second').items[0].filename, 'b.png')

  cache.set('third', { items: [item('c.png')], cursor: null })
  assert.equal(cache.get('first'), undefined)
  assert.equal(cache.get('second').cursor, 'cursor-b')
  assert.equal(cache.get('third').cursor, null)
})
