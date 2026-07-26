import { QdrantClient } from '@qdrant/js-client-rest'

export const createQdrantClient = (config) => new QdrantClient({
  url: config.qdrantUrl,
  apiKey: config.qdrantApiKey,
})

export const ensureCollection = async ({ client, config }) => {
  const exists = await client.collectionExists(config.qdrantCollection)
  if (exists.exists) return

  await client.createCollection(config.qdrantCollection, {
    vectors: {
      size: config.embeddingDimensions,
      distance: 'Cosine',
    },
    on_disk_payload: true,
  })
}

export const retrievePayloads = async ({ client, collectionName, ids, batchSize = 64 }) => {
  const payloads = new Map()

  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize)
    const points = await client.retrieve(collectionName, {
      ids: batch,
      with_payload: true,
      with_vector: false,
    })

    points.forEach((point) => payloads.set(point.id, point.payload || {}))
  }

  return payloads
}

export const upsertPoints = async ({
  client,
  collectionName,
  points,
  batchSize = 64,
}) => {
  for (let index = 0; index < points.length; index += batchSize) {
    await client.upsert(collectionName, {
      wait: true,
      points: points.slice(index, index + batchSize),
    })
  }
}

export const deletePoints = async ({
  client,
  collectionName,
  ids,
  batchSize = 128,
}) => {
  const pointIds = ids.filter(Boolean)

  for (let index = 0; index < pointIds.length; index += batchSize) {
    await client.delete(collectionName, {
      wait: true,
      points: pointIds.slice(index, index + batchSize),
    })
  }

  return pointIds.length
}

export const deleteStalePoints = async ({
  client,
  collectionName,
  currentIds,
  batchSize = 128,
}) => {
  let offset
  const staleIds = []

  do {
    const page = await client.scroll(collectionName, {
      limit: batchSize,
      offset,
      with_payload: true,
      with_vector: false,
    })

    page.points.forEach((point) => {
      if (!currentIds.has(String(point.id))) staleIds.push(point.id)
    })
    offset = page.next_page_offset
  } while (offset !== null && offset !== undefined)

  return deletePoints({
    client,
    collectionName,
    ids: staleIds,
    batchSize,
  })
}

export const pointToSearchResult = (point) => {
  const payload = point.payload || {}
  return {
    filename: payload.filename,
    url: payload.url,
    name: payload.name || payload.filename,
    creator: payload.creator || '',
    modified: payload.modified || '',
    score: point.score,
  }
}
