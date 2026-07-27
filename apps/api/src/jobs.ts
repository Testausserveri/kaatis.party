import fsp from 'node:fs/promises'
import path from 'node:path'

import { createGeminiClient } from '../../../src/search/gemini.js'
import {
  deleteMediaFilesFromIndex,
  indexMediaFile,
} from '../../../src/search/indexer.js'
import {
  createQdrantClient,
  ensureCollection,
} from '../../../src/search/qdrant.js'
import { generatePreview } from './previews.ts'
import type { ApiConfig } from './config.ts'

interface Job {
  id: number
  kind:
    | 'preview'
    | 'preview_only'
    | 'image_embedding'
    | 'video_embedding'
    | 'file_delete'
    | 'preview_delete'
    | 'qdrant_delete'
  filename: string
}

const sleep = (milliseconds: number) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds)
})

const serializeError = (error: unknown) => (
  error instanceof Error ? error.message : String(error)
)

export const createJobRunner = ({
  config,
  store,
  logger,
}: {
  config: ApiConfig
  store: any
  logger: any
}) => {
  const client = createQdrantClient(config)
  let ai: ReturnType<typeof createGeminiClient> | undefined
  let stopped = false
  let videoTail = Promise.resolve()

  const getAi = () => {
    if (!ai) ai = createGeminiClient(config)
    return ai
  }

  const runVideoExclusive = async <T>(fn: () => Promise<T>) => {
    const previous = videoTail
    let release = () => {}
    videoTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  const processPreview = async (job: Job) => {
    const row = store.mediaByFilename(job.filename)
    if (!row) return

    const metadata = await generatePreview({
      row: row as never,
      config,
    })
    store.updatePreview({
      filename: job.filename,
      ...metadata,
      previewStatus: 'ready',
      previewVersion: config.previewVersion,
    })

    if (job.kind === 'preview_only') return

    if (row.media_type === 'image') {
      store.enqueueJob({ kind: 'image_embedding', filename: job.filename })
    }
    if (row.media_type === 'video') {
      store.enqueueJob({ kind: 'video_embedding', filename: job.filename })
    }
  }

  const processEmbedding = async (job: Job) => {
    const row = store.mediaByFilename(job.filename)
    if (!row) return
    await ensureCollection({ client, config })

    const runIndex = () => (indexMediaFile as any)({
      filename: job.filename,
      config,
      ai: getAi(),
      client,
      logger: console,
    })

    if (job.kind === 'video_embedding') {
      await runVideoExclusive(runIndex)
      return
    }
    await runIndex()
  }

  const processDelete = async (job: Job) => {
    await ensureCollection({ client, config })
    await (deleteMediaFilesFromIndex as any)({
      filenames: [job.filename],
      config,
      client,
      logger: console,
    })
  }

  const processJob = async (job: Job) => {
    if (job.kind === 'preview' || job.kind === 'preview_only') {
      await processPreview(job)
      return
    }
    if (job.kind === 'image_embedding' || job.kind === 'video_embedding') {
      await processEmbedding(job)
      return
    }
    if (job.kind === 'qdrant_delete') {
      await processDelete(job)
      return
    }
    if (job.kind === 'file_delete') {
      await fsp.rm(
        path.join(config.uploadDirectory, job.filename),
        { force: true },
      )
      return
    }
    if (job.kind === 'preview_delete') {
      await removePreviewIfUnused(
        job.filename,
        Number(store.mediaCountForChecksum(job.filename)),
      )
      return
    }
    throw new Error(`Tuntematon työ ${job.kind}`)
  }

  const removePreviewIfUnused = async (
    checksum: string,
    mediaCount: number,
  ) => {
    if (!checksum || mediaCount > 0) return
    await fsp.rm(
      path.join(config.previewRoot, `v${config.previewVersion}`, checksum),
      { recursive: true, force: true },
    )
  }

  const worker = async (workerId: number) => {
    while (!stopped) {
      const job = store.claimJob()
      if (!job) {
        await sleep(config.jobPollMs)
        continue
      }

      try {
        await processJob(job)
        store.completeJob(job.id)
        logger.info({
          event: 'media_job_done',
          workerId,
          jobId: job.id,
          kind: job.kind,
          filename: job.filename,
        })
      } catch (error) {
        const message = serializeError(error)
        store.failJob(job.id, message)
        logger.error({
          event: 'media_job_failed',
          workerId,
          jobId: job.id,
          kind: job.kind,
          filename: job.filename,
          error: message,
        })
      }
    }
  }

  return {
    start: () => {
      store.recoverJobs({
        staleBefore: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      })
      return Array.from(
        { length: config.jobWorkers },
        (_, index) => worker(index + 1),
      )
    },
    stop: () => {
      stopped = true
    },
    removePreviewIfUnused,
  }
}
