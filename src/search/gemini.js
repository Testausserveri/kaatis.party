import { GoogleGenAI } from '@google/genai'
import {
  buildDocumentText,
  hashText,
  prepareImageForEmbedding,
} from './media.js'
import { prepareVideoForEmbedding } from './video.js'

export const createGeminiClient = (config) => {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY puuttuu semanttista hakua varten')
  }

  return new GoogleGenAI({ apiKey: config.geminiApiKey })
}

export const embeddingValues = (response) => {
  const values = response?.embeddings?.[0]?.values
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Gemini palautti tyhjän embedding-vastauksen')
  }
  return values
}

const inlinePart = ({ data, mimeType }) => ({
  inlineData: {
    mimeType,
    data: data.toString('base64'),
  },
})

export const storyboardEmbeddingContent = ({ media, storyboard }) => ({
  role: 'user',
  parts: [
    { text: `${buildDocumentText(media)}\ncontent: chronological video storyboard` },
    ...storyboard.map(inlinePart),
  ],
})

export const audioEmbeddingContent = ({ media, audio }) => ({
  role: 'user',
  parts: [
    { text: `${buildDocumentText(media)}\ncontent: video audio track` },
    inlinePart(audio),
  ],
})

export const embedQuery = async ({ ai, query, config }) => {
  const response = await ai.models.embedContent({
    model: config.embeddingModel,
    contents: query,
    config: { outputDimensionality: config.embeddingDimensions },
  })

  return embeddingValues(response)
}

export const embedImageDocument = async ({ ai, media, config }) => {
  const image = await prepareImageForEmbedding(media, config)
  const text = buildDocumentText(media)
  const response = await ai.models.embedContent({
    model: config.embeddingModel,
    contents: {
      role: 'user',
      parts: [
        { text },
        {
          inlineData: {
            mimeType: image.mimeType,
            data: image.data.toString('base64'),
          },
        },
      ],
    },
    config: { outputDimensionality: config.embeddingDimensions },
  })

  return {
    vector: embeddingValues(response),
    sourceTextHash: hashText(text),
    convertedForEmbedding: image.converted,
  }
}

const embedContent = async ({ ai, content, config }) => {
  const response = await ai.models.embedContent({
    model: config.embeddingModel,
    contents: content,
    config: { outputDimensionality: config.embeddingDimensions },
  })
  return embeddingValues(response)
}

export const embedPreparedVideoDocument = async ({
  ai,
  media,
  prepared,
  config,
}) => {
  const components = [{
    kind: 'storyboard',
    segmentIndex: 0,
    startSeconds: 0,
    endSeconds: prepared.indexedDurationSeconds,
    vector: await embedContent({
      ai,
      content: storyboardEmbeddingContent({
        media,
        storyboard: prepared.storyboard,
      }),
      config,
    }),
  }]

  for (const audio of prepared.audio) {
    components.push({
      kind: 'audio',
      segmentIndex: audio.index,
      startSeconds: audio.startSeconds,
      endSeconds: audio.endSeconds,
      vector: await embedContent({
        ai,
        content: audioEmbeddingContent({ media, audio }),
        config,
      }),
    })
  }

  return {
    components,
    sourceTextHash: hashText(buildDocumentText(media)),
  }
}

export const embedVideoDocument = async ({ ai, media, config }) => {
  const prepared = await prepareVideoForEmbedding(media, config)
  try {
    const embedding = await embedPreparedVideoDocument({
      ai,
      media,
      prepared,
      config,
    })
    return {
      ...embedding,
      durationSeconds: prepared.durationSeconds,
      indexedDurationSeconds: prepared.indexedDurationSeconds,
      truncated: prepared.truncated,
    }
  } finally {
    await prepared.cleanup()
  }
}
