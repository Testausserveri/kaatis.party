import fsp from 'node:fs/promises'

import { createMediaStore } from '../../../src/mediaStore.js'
import { getApiConfig } from './config.ts'

const config = getApiConfig()
const store = createMediaStore(config.mediaDbPath)

try {
  let state
  try {
    state = JSON.parse(await fsp.readFile(config.videoBatchStatePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(JSON.stringify({
        event: 'gemini_batch_migration',
        imported: 0,
        reason: 'state_file_missing',
      }))
      process.exit(0)
    }
    throw error
  }

  for (const batch of state.jobs || []) {
    store.importGeminiBatch(batch)
  }

  await fsp.rename(
    config.videoBatchStatePath,
    `${config.videoBatchStatePath}.migrated-backup`,
  )
  console.log(JSON.stringify({
    event: 'gemini_batch_migration',
    imported: (state.jobs || []).length,
  }))
} finally {
  store.close()
}
