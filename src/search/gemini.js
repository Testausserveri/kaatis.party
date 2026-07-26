import { GoogleGenAI } from '@google/genai'
import {
  buildDocumentText,
  hashText,
  prepareImageForEmbedding,
} from './media.js'

export const createGeminiClient = (config) => {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY puuttuu semanttista hakua varten')
  }

  return new GoogleGenAI({ apiKey: config.geminiApiKey })
}

const embeddingValues = (response) => {
  const values = response?.embeddings?.[0]?.values
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Gemini palautti tyhjän embedding-vastauksen')
  }
  return values
}

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
