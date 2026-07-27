import fsp from 'fs/promises'
import path from 'path'
import { getSearchConfig } from './config.js'
import {
  audioEmbeddingContent,
  createGeminiClient,
  storyboardEmbeddingContent,
} from './gemini.js'
import {
  buildDocumentText,
  checksumFile,
  hashText,
  payloadMatches,
  readIndexedMedia,
  readIndexedMediaFile,
} from './media.js'
import {
  videoPointsFromComponents,
} from './indexer.js'
import {
  createQdrantClient,
  deletePointsForFilenames,
  ensureCollection,
  retrievePayloads,
  upsertPoints,
} from './qdrant.js'
import { prepareVideoForEmbedding } from './video.js'

const terminalStates = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
])

const emptyState = () => ({ version: 1, jobs: [] })

const readState = async (statePath) => {
  try {
    return JSON.parse(await fsp.readFile(statePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState()
    throw error
  }
}

const writeState = async (statePath, state) => {
  await fsp.mkdir(path.dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.tmp`
  await fsp.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`)
  await fsp.rename(temporaryPath, statePath)
}

const requestKey = ({ filename, kind, segmentIndex }) => (
  hashText(`${filename}\0${kind}\0${segmentIndex}`).slice(0, 32)
)

const batchRequest = ({ key, content, config }) => ({
  metadata: { key },
  request: {
    model: `models/${config.embeddingModel}`,
    content,
    outputDimensionality: config.embeddingDimensions,
  },
})

export const preparedVideoBatchItem = ({
  media,
  prepared,
  checksum,
  sourceTextHash,
  config,
}) => {
  const requests = []
  const lines = []
  const storyboardKey = requestKey({
    filename: media.filename,
    kind: 'storyboard',
    segmentIndex: 0,
  })
  requests.push({
    key: storyboardKey,
    kind: 'storyboard',
    segmentIndex: 0,
    startSeconds: 0,
    endSeconds: prepared.indexedDurationSeconds,
  })
  lines.push(JSON.stringify(batchRequest({
    key: storyboardKey,
    content: storyboardEmbeddingContent({
      media,
      storyboard: prepared.storyboard,
    }),
    config,
  })))

  prepared.audio.forEach((audio) => {
    const key = requestKey({
      filename: media.filename,
      kind: 'audio',
      segmentIndex: audio.index,
    })
    requests.push({
      key,
      kind: 'audio',
      segmentIndex: audio.index,
      startSeconds: audio.startSeconds,
      endSeconds: audio.endSeconds,
    })
    lines.push(JSON.stringify(batchRequest({
      key,
      content: audioEmbeddingContent({ media, audio }),
      config,
    })))
  })

  return {
    manifest: {
      filename: media.filename,
      checksum,
      sourceTextHash,
      durationSeconds: prepared.durationSeconds,
      indexedDurationSeconds: prepared.indexedDurationSeconds,
      truncated: prepared.truncated,
      requests,
    },
    lines,
    bytes: lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0),
  }
}

const submitJob = async ({
  ai,
  config,
  state,
  statePath,
  items,
  lines,
  logger,
}) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonlPath = path.join(
    config.videoTempDirectory,
    `kaatis-video-batch-${timestamp}.jsonl`,
  )
  await fsp.writeFile(jsonlPath, `${lines.join('\n')}\n`)

  try {
    const uploaded = await ai.files.upload({
      file: jsonlPath,
      config: {
        mimeType: 'application/jsonl',
        displayName: `kaatis-video-batch-${timestamp}`,
      },
    })
    if (!ai.batches?.createEmbeddings) {
      throw new Error('@google/genai ei tue batches.createEmbeddings-metodia')
    }
    const batch = await ai.batches.createEmbeddings({
      model: config.embeddingModel,
      src: { fileName: uploaded.name },
      config: { displayName: `kaatis-video-embeddings-${timestamp}` },
    })
    state.jobs.push({
      name: batch.name,
      state: batch.state || 'JOB_STATE_PENDING',
      inputFileName: uploaded.name,
      createdAt: new Date().toISOString(),
      imported: false,
      items,
    })
    await writeState(statePath, state)
    logger.log(`Lähetetty Batch-ajo ${batch.name}: ${items.length} videota`)
  } finally {
    await fsp.rm(jsonlPath, { force: true })
  }
}

export const submitVideoBatches = async ({
  config = getSearchConfig(),
  logger = console,
  ai = createGeminiClient(config),
  client = createQdrantClient(config),
} = {}) => {
  await ensureCollection({ client, config })
  const statePath = config.videoBatchStatePath
  const state = await readState(statePath)
  const activeFilenames = new Set(state.jobs
    .filter((job) => !job.imported && (
      !terminalStates.has(job.state) || job.state === 'JOB_STATE_SUCCEEDED'
    ))
    .flatMap((job) => job.items.map((item) => item.filename)))
  const matchTerms = config.indexMatch.split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
  let videos = (await readIndexedMedia(config))
    .filter((media) => media.mediaType === 'video')
    .filter((media) => !activeFilenames.has(media.filename))
  if (matchTerms.length > 0) {
    videos = videos.filter((media) => matchTerms
      .some((term) => media.filename.toLowerCase().includes(term)))
  }
  if (config.indexLimit > 0) videos = videos.slice(0, config.indexLimit)
  const existingPayloads = await retrievePayloads({
    client,
    collectionName: config.qdrantCollection,
    ids: videos.map((video) => video.id),
    batchSize: config.qdrantBatchSize,
  })

  let currentItems = []
  let currentLines = []
  let currentBytes = 0
  let submitted = 0
  let skipped = 0
  let failed = 0

  const flush = async () => {
    if (currentItems.length === 0) return
    await submitJob({
      ai,
      config,
      state,
      statePath,
      items: currentItems,
      lines: currentLines,
      logger,
    })
    submitted += currentItems.length
    currentItems = []
    currentLines = []
    currentBytes = 0
  }

  for (const media of videos) {
    try {
      const checksum = await checksumFile(media.filePath)
      const sourceTextHash = hashText(buildDocumentText(media))
      if (payloadMatches({
        payload: existingPayloads.get(media.id),
        checksum,
        sourceTextHash,
        config,
        embeddingInputVersion: config.videoEmbeddingInputVersion,
      })) {
        skipped += 1
        continue
      }

      const prepared = await prepareVideoForEmbedding(media, config)
      let item
      try {
        item = preparedVideoBatchItem({
          media,
          prepared,
          checksum,
          sourceTextHash,
          config,
        })
      } finally {
        await prepared.cleanup()
      }

      if (
        currentItems.length > 0
        && (
          currentItems.length >= config.videoBatchFiles
          || currentBytes + item.bytes > config.videoBatchMaxBytes
        )
      ) {
        await flush()
      }
      currentItems.push(item.manifest)
      currentLines.push(...item.lines)
      currentBytes += item.bytes
    } catch (error) {
      failed += 1
      logger.error(`Ohitetaan video ${media.filename}: ${error.message}`)
    }
  }
  await flush()

  return {
    total: videos.length,
    submitted,
    skipped,
    failed,
    jobs: state.jobs.length,
  }
}

export const refreshVideoBatchStatus = async ({
  config = getSearchConfig(),
  logger = console,
  ai = createGeminiClient(config),
} = {}) => {
  const state = await readState(config.videoBatchStatePath)
  for (const job of state.jobs) {
    if (job.imported || terminalStates.has(job.state)) continue
    const remote = await ai.batches.get({ name: job.name })
    job.state = remote.state
    job.outputFileName = remote.dest?.fileName
      || remote.output?.fileName
      || remote.output?.responsesFile
      || job.outputFileName
    job.updatedAt = new Date().toISOString()
    job.batchStats = remote.batchStats || remote.batch_stats
    logger.log(`${job.name}: ${job.state}`)
  }
  await writeState(config.videoBatchStatePath, state)
  return state.jobs.map((job) => ({
    name: job.name,
    state: job.state,
    imported: job.imported,
    files: job.items.length,
    batchStats: job.batchStats,
  }))
}

const responseVector = (line) => (
  line.response?.embeddings?.[0]?.values
  || line.response?.embedding?.values
  || line.embedding?.values
)

export const downloadBatchResponses = async ({ ai, job, config }) => {
  const { outputFileName: storedOutputFileName } = job
  let outputFileName = storedOutputFileName
  if (!outputFileName) {
    const remote = await ai.batches.get({ name: job.name })
    outputFileName = remote.dest?.fileName
      || remote.output?.fileName
      || remote.output?.responsesFile
  }
  if (!outputFileName) throw new Error(`Batch-ajolta ${job.name} puuttuu tulostiedosto`)
  const downloadPath = path.join(
    config.videoTempDirectory,
    `kaatis-video-batch-response-${hashText(job.name).slice(0, 16)}.jsonl`,
  )
  await fsp.mkdir(path.dirname(downloadPath), { recursive: true })
  await ai.files.download({ file: outputFileName, downloadPath })
  let text
  try {
    text = await fsp.readFile(downloadPath, 'utf8')
  } finally {
    await fsp.rm(downloadPath, { force: true })
  }
  const vectors = new Map()
  const errors = new Map()
  const expectedKeys = job.items.flatMap((item) => item.requests.map((request) => request.key))
  text.split('\n').filter(Boolean).forEach((row, index) => {
    const line = JSON.parse(row)
    const key = line.metadata?.key
      || line.key
      || line.requestKey
      || line.request_key
      || expectedKeys[index]
    const vector = responseVector(line)
    if (key && Array.isArray(vector)) vectors.set(key, vector)
    if (key && line.error) errors.set(key, line.error)
  })
  return { vectors, errors }
}

export const importVideoBatches = async ({
  config = getSearchConfig(),
  logger = console,
  ai = createGeminiClient(config),
  client = createQdrantClient(config),
} = {}) => {
  await ensureCollection({ client, config })
  const state = await readState(config.videoBatchStatePath)
  let imported = 0
  let stale = 0
  let failed = 0

  for (const job of state.jobs) {
    if (job.imported || job.state !== 'JOB_STATE_SUCCEEDED') continue
    const responses = await downloadBatchResponses({ ai, job, config })

    for (const item of job.items) {
      const media = await readIndexedMediaFile({ config, filename: item.filename })
      if (!media || await checksumFile(media.filePath) !== item.checksum) {
        stale += 1
        continue
      }
      const components = []
      let complete = true
      item.requests.forEach((request) => {
        const vector = responses.vectors.get(request.key)
        if (!vector) {
          complete = false
          return
        }
        components.push({ ...request, vector })
      })
      if (!complete) {
        failed += 1
        continue
      }

      const points = videoPointsFromComponents({
        media,
        checksum: item.checksum,
        sourceTextHash: item.sourceTextHash,
        components,
        durationSeconds: item.durationSeconds,
        indexedDurationSeconds: item.indexedDurationSeconds,
        truncated: item.truncated,
        config,
      })
      await upsertPoints({
        client,
        collectionName: config.qdrantCollection,
        points,
        batchSize: config.qdrantBatchSize,
      })
      await deletePointsForFilenames({
        client,
        collectionName: config.qdrantCollection,
        filenames: [media.filename],
        exceptIds: new Set(points.map((point) => String(point.id))),
        batchSize: config.qdrantBatchSize,
      })
      imported += 1
    }

    job.imported = true
    job.importedAt = new Date().toISOString()
    job.importSummary = { imported, stale, failed }
    // Batch output files use API-generated names that the Files delete endpoint
    // does not accept. They expire server-side; only remove our uploaded input.
    for (const fileName of [job.inputFileName].filter(Boolean)) {
      try {
        await ai.files.delete({ name: fileName })
      } catch (error) {
        logger.error(`Gemini-tiedoston ${fileName} poisto epäonnistui: ${error.message}`)
      }
    }
    await writeState(config.videoBatchStatePath, state)
  }

  return { imported, stale, failed }
}

const command = process.argv[2]
if (import.meta.url === `file://${process.argv[1]}`) {
  const actions = {
    submit: submitVideoBatches,
    status: refreshVideoBatchStatus,
    import: importVideoBatches,
  }
  if (!actions[command]) {
    console.error('Käyttö: npm run search:index:video-batch -- <submit|status|import>')
    process.exitCode = 1
  } else {
    actions[command]()
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error)
        process.exitCode = 1
      })
  }
}
