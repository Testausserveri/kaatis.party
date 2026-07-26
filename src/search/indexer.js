import { getSearchConfig } from './config.js'
import { createGeminiClient, embedImageDocument } from './gemini.js'
import {
  buildDocumentText,
  checksumFile,
  hashText,
  mediaPayload,
  payloadMatches,
  pointIdForFilename,
  readIndexedMedia,
  readIndexedMediaFile,
  safeMediaFilename,
  isImageFilename,
} from './media.js'
import {
  createQdrantClient,
  deletePoints,
  deleteStalePoints,
  ensureCollection,
  retrievePayloads,
  upsertPoints,
} from './qdrant.js'

const chunk = (items, size) => {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

const filterMedia = ({ media, config }) => {
  const matchTerms = config.indexMatch
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)

  const matchedMedia = matchTerms.length > 0
    ? media.filter((item) => matchTerms.some((term) => item.filename.toLowerCase().includes(term)))
    : media

  return config.indexLimit > 0 ? matchedMedia.slice(0, config.indexLimit) : matchedMedia
}

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length)
  let nextIndex = 0

  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  })

  await Promise.all(workers)
  return results
}

export const buildPoint = async ({
  ai,
  media,
  existingPayload,
  config,
}) => {
  const checksum = await checksumFile(media.filePath)
  const sourceTextHash = hashText(buildDocumentText(media))

  if (payloadMatches({
    payload: existingPayload,
    checksum,
    sourceTextHash,
    config,
  })) {
    return { status: 'skipped' }
  }

  const gemini = ai || createGeminiClient(config)
  const embedding = await embedImageDocument({ ai: gemini, media, config })

  return {
    status: 'indexed',
    point: {
      id: media.id,
      vector: embedding.vector,
      payload: mediaPayload({
        media,
        checksum,
        sourceTextHash: embedding.sourceTextHash,
        config,
        convertedForEmbedding: embedding.convertedForEmbedding,
      }),
    },
  }
}

const processMediaBatch = async ({
  ai,
  config,
  existingPayloads,
  logger,
  mediaBatch,
  state,
  total,
}) => {
  let { processed, skipped, failed } = state

  const results = await mapWithConcurrency(mediaBatch, config.indexConcurrency, async (item) => {
    try {
      const result = await buildPoint({
        ai,
        media: item,
        existingPayload: existingPayloads.get(item.id),
        config,
      })

      processed += 1
      if (result.status === 'skipped') skipped += 1
      if (processed % 25 === 0 || processed === total) {
        logger.log(`Käsitelty ${processed}/${total}; indeksoitu ${state.indexed}; ohitettu ${skipped}; epäonnistunut ${failed}`)
      }
      return result
    } catch (e) {
      processed += 1
      failed += 1
      logger.error(`Tiedoston ${item.filename} indeksointi epäonnistui: ${e.message}`)
      return { status: 'failed', error: e }
    }
  })

  return {
    points: results
      .filter((result) => result.status === 'indexed')
      .map((result) => result.point),
    state: {
      ...state,
      processed,
      skipped,
      failed,
    },
  }
}

export const indexMediaFile = async ({
  filename,
  config = getSearchConfig(),
  logger = console,
  ai,
  client,
} = {}) => {
  const qdrant = client || createQdrantClient(config)
  await ensureCollection({ client: qdrant, config })

  const media = await readIndexedMediaFile({ config, filename })
  if (!media) {
    return {
      status: 'not_indexable',
      filename,
      indexed: false,
      skipped: false,
    }
  }

  const existingPayloads = await retrievePayloads({
    client: qdrant,
    collectionName: config.qdrantCollection,
    ids: [media.id],
    batchSize: 1,
  })
  const result = await buildPoint({
    ai,
    media,
    existingPayload: existingPayloads.get(media.id),
    config,
  })

  if (result.status === 'skipped') {
    logger.log(`Tiedosto ${media.filename} on jo ajan tasalla Qdrantissa`)
    return {
      status: 'skipped',
      filename: media.filename,
      indexed: false,
      skipped: true,
    }
  }

  await upsertPoints({
    client: qdrant,
    collectionName: config.qdrantCollection,
    points: [result.point],
    batchSize: 1,
  })
  logger.log(`Indeksoitu uusi tai muuttunut tiedosto ${media.filename}`)

  return {
    status: 'indexed',
    filename: media.filename,
    indexed: true,
    skipped: false,
  }
}

export const deleteMediaFilesFromIndex = async ({
  filenames,
  config = getSearchConfig(),
  logger = console,
  client,
} = {}) => {
  const imageFilenames = [...new Set((Array.isArray(filenames) ? filenames : [filenames])
    .map(safeMediaFilename)
    .filter((filename) => filename && isImageFilename(filename)))]

  if (imageFilenames.length === 0) {
    return {
      status: 'skipped',
      deleted: 0,
      filenames: [],
    }
  }

  const qdrant = client || createQdrantClient(config)
  const exists = await qdrant.collectionExists(config.qdrantCollection)
  if (!exists.exists) {
    return {
      status: 'missing_collection',
      deleted: 0,
      filenames: imageFilenames,
    }
  }

  const deleted = await deletePoints({
    client: qdrant,
    collectionName: config.qdrantCollection,
    ids: imageFilenames.map(pointIdForFilename),
    batchSize: config.qdrantBatchSize,
  })

  logger.log(`Poistettu ${deleted} tiedosto(a) Qdrant-indeksistä`)

  return {
    status: 'deleted',
    deleted,
    filenames: imageFilenames,
  }
}

export const runIndexer = async ({
  config = getSearchConfig(),
  logger = console,
} = {}) => {
  const ai = createGeminiClient(config)
  const client = createQdrantClient(config)

  logger.log(`Varmistetaan Qdrant-kokoelma ${config.qdrantCollection}`)
  await ensureCollection({ client, config })

  const allMedia = await readIndexedMedia(config)
  const media = filterMedia({ media: allMedia, config })
  const currentIds = new Set(allMedia.map((item) => item.id))

  logger.log(`Löytyi ${allMedia.length} indeksoitavaa kuva(a); käsitellään ${media.length}`)
  if (config.indexMatch) logger.log(`Indeksointisuodatin: ${config.indexMatch}`)

  const state = {
    processed: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
  }

  for (const mediaBatch of chunk(media, config.qdrantBatchSize)) {
    const existingPayloads = await retrievePayloads({
      client,
      collectionName: config.qdrantCollection,
      ids: mediaBatch.map((item) => item.id),
      batchSize: config.qdrantBatchSize,
    })

    const batchResult = await processMediaBatch({
      ai,
      config,
      existingPayloads,
      logger,
      mediaBatch,
      state,
      total: media.length,
    })
    state.processed = batchResult.state.processed
    state.skipped = batchResult.state.skipped
    state.failed = batchResult.state.failed

    if (batchResult.points.length > 0) {
      await upsertPoints({
        client,
        collectionName: config.qdrantCollection,
        points: batchResult.points,
        batchSize: config.qdrantBatchSize,
      })
      state.indexed += batchResult.points.length
      logger.log(`Tallennettu ${batchResult.points.length} muuttunutta pistettä; tällä ajolla indeksoitu yhteensä ${state.indexed}`)
    }
  }

  let deleted = 0
  if (config.deleteStale && config.indexLimit === 0 && !config.indexMatch) {
    deleted = await deleteStalePoints({
      client,
      collectionName: config.qdrantCollection,
      currentIds,
    })
    if (deleted > 0) logger.log(`Poistettu ${deleted} vanhentunutta pistettä`)
  }

  return {
    total: allMedia.length,
    processed: media.length,
    indexed: state.indexed,
    skipped: state.skipped,
    failed: state.failed,
    deleted,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexer()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2))
    })
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
}
