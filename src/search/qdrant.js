import { QdrantClient } from '@qdrant/js-client-rest'

export const createQdrantClient = (config) => new QdrantClient({
  url: config.qdrantUrl,
  apiKey: config.qdrantApiKey,
})

export const ensureCollection = async ({ client, config }) => {
  const exists = await client.collectionExists(config.qdrantCollection)
  if (!exists.exists) {
    await client.createCollection(config.qdrantCollection, {
      vectors: {
        size: config.embeddingDimensions,
        distance: 'Cosine',
      },
      on_disk_payload: true,
    })
  }

  const collection = await client.getCollection(config.qdrantCollection)
  for (const fieldName of ['filename', 'mediaType', 'pointKind', 'modality']) {
    if (!collection.payload_schema?.[fieldName]) {
      await client.createPayloadIndex(config.qdrantCollection, {
        field_name: fieldName,
        field_schema: 'keyword',
        wait: true,
      })
    }
  }
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

export const pointsForFilenames = async ({
  client,
  collectionName,
  filenames,
  withVector = false,
  batchSize = 128,
}) => {
  const values = [...new Set(filenames.filter(Boolean))]
  if (values.length === 0) return []

  let offset
  const points = []
  do {
    const page = await client.scroll(collectionName, {
      limit: batchSize,
      offset,
      filter: {
        must: [{
          key: 'filename',
          match: { any: values },
        }],
      },
      with_payload: true,
      with_vector: withVector,
    })
    points.push(...page.points)
    offset = page.next_page_offset
  } while (offset !== null && offset !== undefined)
  return points
}

export const deletePointsForFilenames = async ({
  client,
  collectionName,
  filenames,
  exceptIds = new Set(),
  batchSize = 128,
}) => {
  const points = await pointsForFilenames({
    client,
    collectionName,
    filenames,
    batchSize,
  })
  return deletePoints({
    client,
    collectionName,
    ids: points
      .map((point) => point.id)
      .filter((id) => !exceptIds.has(String(id))),
    batchSize,
  })
}

export const deleteStalePoints = async ({
  client,
  collectionName,
  currentIds,
  currentFilenames,
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
      const filename = point.payload?.filename
      const stale = currentFilenames
        ? !filename || !currentFilenames.has(filename)
        : !currentIds.has(String(point.id))
      if (stale) staleIds.push(point.id)
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

export const queryGroupedPoints = async ({
  client,
  collectionName,
  vector,
  limit,
  scoreThreshold,
  filter,
}) => {
  const query = {
    query: vector,
    group_by: 'filename',
    group_size: 1,
    limit,
    score_threshold: scoreThreshold,
    with_payload: true,
    with_vector: false,
  }
  if (filter) query.filter = filter
  const result = await client.queryGroups(collectionName, query)
  return (result.groups || [])
    .map((group) => group.hits?.[0])
    .filter(Boolean)
}

const excludedFilenamesFilter = (excludedFilenames) => {
  const filenames = [...new Set(excludedFilenames || [])].filter(Boolean)
  return filenames.length > 0
    ? [{ key: 'filename', match: { any: filenames } }]
    : []
}

const mediaFilter = ({
  mediaType,
  pointKind,
  modality,
  filenames,
  excludedFilenames,
}) => ({
  must: [
    { key: 'mediaType', match: { value: mediaType } },
    ...(pointKind ? [{ key: 'pointKind', match: { value: pointKind } }] : []),
    ...(modality ? [{ key: 'modality', match: { value: modality } }] : []),
    ...(filenames?.length
      ? [{ key: 'filename', match: { any: filenames } }]
      : []),
  ],
  must_not: excludedFilenamesFilter(excludedFilenames),
})

export const normalizedRrfScore = (rank, constant = 60) => (
  (constant + 1) / (constant + rank)
)

export const mergeRankedMediaPoints = ({
  imagePoints,
  videoPoints,
  limit,
}) => {
  const points = []
  const maxLength = Math.max(imagePoints.length, videoPoints.length)

  for (let index = 0; index < maxLength && points.length < limit; index += 1) {
    const rank = index + 1
    for (const point of [imagePoints[index], videoPoints[index]]) {
      if (!point || points.length >= limit) continue
      points.push({
        ...point,
        score: normalizedRrfScore(rank),
        similarityScore: point.similarityScore ?? point.score,
      })
    }
  }

  return points
}

const normalizedModalityScore = (score, threshold) => (
  (score - threshold) / (1 - threshold)
)

export const mergeVideoComponentPoints = ({
  audioPoints,
  storyboardPoints,
  audioThreshold,
  storyboardThreshold,
  limit,
}) => {
  const byFilename = new Map()
  for (const [points, threshold] of [
    [audioPoints, audioThreshold],
    [storyboardPoints, storyboardThreshold],
  ]) {
    for (const point of points) {
      const filename = point.payload?.filename
      if (!filename || point.score < threshold) continue
      const modalityScore = normalizedModalityScore(point.score, threshold)
      const current = byFilename.get(filename)
      if (current && current.modalityScore >= modalityScore) continue
      byFilename.set(filename, {
        ...point,
        score: modalityScore,
        similarityScore: point.score,
        modalityScore,
      })
    }
  }

  return [...byFilename.values()]
    .sort((a, b) => b.modalityScore - a.modalityScore)
    .slice(0, limit)
}

export const queryBalancedMediaPoints = async ({
  client,
  collectionName,
  vector,
  limit,
  scoreThreshold,
  excludedFilenames = new Set(),
  videoAudioScoreThreshold = 0.6,
  videoStoryboardScoreThreshold = 0.45,
}) => {
  const { imagePoints, videoPoints } = await querySemanticMediaLists({
    client,
    collectionName,
    vector,
    limit,
    scoreThreshold,
    excludedFilenames,
    videoAudioScoreThreshold,
    videoStoryboardScoreThreshold,
  })
  return mergeRankedMediaPoints({
    imagePoints,
    videoPoints,
    limit,
  })
}

export const querySemanticMediaLists = async ({
  client,
  collectionName,
  vector,
  limit,
  scoreThreshold,
  excludedFilenames = new Set(),
  videoAudioScoreThreshold = 0.6,
  videoStoryboardScoreThreshold = 0.45,
}) => {
  const [imagePoints, audioPoints, storyboardPoints] = await Promise.all([
    queryGroupedPoints({
      client,
      collectionName,
      vector,
      limit,
      scoreThreshold,
      filter: mediaFilter({
        mediaType: 'image',
        excludedFilenames,
      }),
    }),
    queryGroupedPoints({
      client,
      collectionName,
      vector,
      limit,
      scoreThreshold: Math.max(scoreThreshold || 0, videoAudioScoreThreshold),
      filter: mediaFilter({
        mediaType: 'video',
        pointKind: 'component',
        modality: 'audio',
        excludedFilenames,
      }),
    }),
    queryGroupedPoints({
      client,
      collectionName,
      vector,
      limit,
      scoreThreshold: Math.max(scoreThreshold || 0, videoStoryboardScoreThreshold),
      filter: mediaFilter({
        mediaType: 'video',
        pointKind: 'component',
        modality: 'storyboard',
        excludedFilenames,
      }),
    }),
  ])

  const videoPoints = mergeVideoComponentPoints({
    audioPoints,
    storyboardPoints,
    audioThreshold: videoAudioScoreThreshold,
    storyboardThreshold: videoStoryboardScoreThreshold,
    limit,
  })

  return {
    imagePoints,
    videoPoints,
  }
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
