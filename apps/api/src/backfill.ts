import { createMediaStore } from '../../../src/mediaStore.js'
import { getApiConfig } from './config.ts'

const config = getApiConfig()
const store = createMediaStore(config.mediaDbPath)

try {
  let queued = 0
  for (const row of store.listMedia()) {
    if (
      row.preview_status === 'ready'
      && row.preview_version === config.previewVersion
      && row.checksum
    ) {
      continue
    }
    const result = store.enqueueJob({
      kind: 'preview_only',
      filename: row.filename,
    })
    if (result.changes > 0) queued += 1
  }
  console.log(JSON.stringify({
    event: 'preview_backfill_queued',
    queued,
    pending: store.pendingJobCount(),
  }))
} finally {
  store.close()
}
