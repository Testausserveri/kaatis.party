import { GoogleGenAI } from '@google/genai'
import { messageToContextText } from './memeCommand.js'

export const defaultMemeQueryModel = 'gemini-3.5-flash-lite'

const normalizeWhitespace = (value) => String(value || '').replace(/\s+/g, ' ').trim()

export const sanitizeGeneratedQuery = (value, { maxLength = 120 } = {}) => {
  let query = normalizeWhitespace(value)
    .replace(/^```(?:json|text)?/i, '')
    .replace(/```$/i, '')
    .trim()

  if (
    (query.startsWith('"') && query.endsWith('"'))
    || (query.startsWith("'") && query.endsWith("'"))
  ) {
    query = query.slice(1, -1).trim()
  }

  if (query.length > maxLength) {
    query = query.slice(0, maxLength).trim()
  }

  return query
}

export const messagesForGeminiQuery = (messages, { limit = 10 } = {}) => [...messages]
  .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
  .slice(-limit)
  .reverse()
  .map((message, index) => ({
    index: index + 1,
    newest: index === 0,
    author: message.author?.username || message.author?.tag || '',
    content: messageToContextText(message),
  }))
  .filter((message) => message.content)

export const buildGeminiMemeQueryPrompt = (messages) => {
  const lines = messages.map((message) => (
    `${message.index}. ${message.newest ? '[UUSIN, TÄRKEIN] ' : ''}${message.content}`
  ))

  return [
    'Poimi viesteistä paras hakusana kaatis.party-meemiarkiston semanttiseen kuvahakuun.',
    '',
    'Ohje:',
    '- Uusin viesti painaa eniten; käytä vanhempia viestejä vain kontekstina.',
    '- Palauta 1-5 sanan hakukysely, ei selitystä eikä JSONia.',
    '- Etsi arkistosta haettava ydinasia: henkilö, nimi, tuote, paikka, ohjelma, termi, aihe tai vitsi.',
    '- Karsi kysymys-, täyte- ja ryhmäsanat, esimerkiksi "löytyykö", "entä", "meemi", "fanit", "käyttäjät", "fanaatikot".',
    '- Jos viestissä on URL tai GitHub-repo, palauta sopiva ydintermi repo-/tuotenimestä, älä osoitetta.',
    '',
    'Esimerkkejä:',
    'löytyykö vaikka eemilistä meemejä -> eemil',
    'github.com/ndycode/codex-multi-auth -> codex',
    '||emacs fanaatikot, siitäs saitte|| -> emacs',
    'no siis vituttaa nyttenkin mut eriasiat nyway -> vituttaa',
    'ei muutaku ydinpommia vaan niskaan ja deletee -> delete (tai ydinpommi)',
    'mitä tykkäätte r-kioskista? -> r-kioski',
    '',
    'Viestit uusimmasta vanhimpaan:',
    ...lines,
  ].join('\n')
}

export const createGeminiMemeQueryClient = ({ apiKey }) => {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY puuttuu Gemini-hakukyselyn muodostusta varten')
  }

  return new GoogleGenAI({ apiKey })
}

export const generateMemeSearchQuery = async ({
  ai,
  model = defaultMemeQueryModel,
  messages,
  fallbackQuery,
  limit = 10,
  maxLength = 120,
}) => {
  const promptMessages = messagesForGeminiQuery(messages, { limit })

  if (promptMessages.length === 0) {
    return {
      query: fallbackQuery,
      source: 'fallback',
      prompt: '',
      rawText: '',
      error: 'no_messages',
    }
  }

  const prompt = buildGeminiMemeQueryPrompt(promptMessages)
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      maxOutputTokens: 32,
      responseMimeType: 'text/plain',
    },
  })
  const rawText = response.text || ''
  const query = sanitizeGeneratedQuery(rawText, { maxLength })

  return {
    query: query || fallbackQuery,
    source: query ? 'gemini' : 'fallback',
    prompt,
    rawText,
    error: query ? '' : 'empty_response',
  }
}
