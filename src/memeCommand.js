export const defaultMemeSearchCommands = ['!meemi']
export const defaultMemeSlashCommandName = 'kaatis'
export const legacyMemeSlashCommandNames = ['meemi']
export const defaultMemeMessageCommandName = 'Meemi tästä'
export const memeSearchOptionName = 'hakusana'

const normalizeWhitespace = (value) => String(value || '').replace(/\s+/g, ' ').trim()

const truncateText = (value, maxLength) => {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}

export const positiveInteger = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

export const nonNegativeNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export const isMemeSearchCommand = (
  content,
  commands = defaultMemeSearchCommands,
) => {
  const firstToken = normalizeWhitespace(content).split(' ')[0].toLowerCase()
  return commands.includes(firstToken)
}

export const isMemeSlashCommand = (
  commandName,
  expectedName = defaultMemeSlashCommandName,
) => (
  normalizeWhitespace(commandName).toLowerCase()
  === normalizeWhitespace(expectedName).toLowerCase()
)

export const memeSlashCommandDefinition = (
  name = defaultMemeSlashCommandName,
) => ({
  name,
  type: 1,
  description: 'Etsi keskusteluun sopiva meemi',
  name_localizations: null,
  description_localizations: null,
  options: [
    {
      name: memeSearchOptionName,
      type: 3,
      description: 'Hae suoraan tällä hakusanalla',
      required: false,
      min_length: 1,
      max_length: 120,
      name_localizations: null,
      description_localizations: null,
    },
  ],
})

export const memeMessageCommandDefinition = (
  name = defaultMemeMessageCommandName,
) => ({
  name,
  type: 3,
  name_localizations: null,
})

const hasMediaResult = (result) => Boolean(result?.url || result?.filename)

export const closeMemeResultPool = (results, {
  scoreDelta = 0.035,
  maxPoolSize = 4,
} = {}) => {
  const usableResults = (Array.isArray(results) ? results : []).filter(hasMediaResult)
  if (usableResults.length === 0) return []

  const topScore = Number(usableResults[0].score)
  if (!Number.isFinite(topScore)) return usableResults.slice(0, 1)

  return usableResults
    .filter((result) => {
      const score = Number(result.score)
      return Number.isFinite(score) && score >= topScore - scoreDelta
    })
    .slice(0, maxPoolSize)
}

export const selectMemeSearchResult = (results, {
  scoreDelta = 0.035,
  maxPoolSize = 4,
  random = Math.random,
} = {}) => {
  const pool = closeMemeResultPool(results, { scoreDelta, maxPoolSize })
  if (pool.length === 0) return { result: null, pool }

  const randomValue = Math.max(0, Math.min(0.999999999, Number(random()) || 0))
  const selectedIndex = Math.floor(randomValue * pool.length)
  return {
    result: pool[selectedIndex],
    pool,
    selectedIndex,
  }
}

export const messageToContextText = (message) => {
  const content = normalizeWhitespace(message.cleanContent || message.content)
    .replace(/\|\|/g, '')
  const attachmentNames = message.attachments?.values
    ? Array.from(message.attachments.values())
      .map((attachment) => normalizeWhitespace(attachment.name))
      .filter(Boolean)
    : []

  return [
    content,
    attachmentNames.length > 0 ? `liitteet: ${attachmentNames.join(', ')}` : '',
  ].filter(Boolean).join(' ')
}

const composeQuery = ({ latest, older }) => [
  latest[0] ? `uusin viesti: ${latest[0]}` : '',
  latest.length > 1 ? `edeltävät viestit: ${latest.slice(1).join(' | ')}` : '',
  older.length > 0 ? `taustakonteksti: ${older.join(' | ')}` : '',
].filter(Boolean).join('\n')

export const buildMemeSearchQuery = (messages, {
  limit = 10,
  maxLength = 480,
} = {}) => {
  const normalizedMessages = [...messages]
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
    .map(messageToContextText)
    .map((text) => truncateText(text, 180))
    .filter(Boolean)
    .slice(-limit)

  if (normalizedMessages.length === 0) return ''

  const newestFirst = [...normalizedMessages].reverse()
  let latest = newestFirst.slice(0, 3)
  let older = newestFirst.slice(3)
  let query = composeQuery({ latest, older })

  while (query.length > maxLength && older.length > 0) {
    older = older.slice(0, -1)
    query = composeQuery({ latest, older })
  }

  while (query.length > maxLength && latest.some((text) => text.length > 80)) {
    latest = latest.map((text) => truncateText(
      text,
      Math.max(80, Math.floor(text.length * 0.75)),
    ))
    query = composeQuery({ latest, older })
  }

  return truncateText(query, maxLength)
}

export const absoluteMediaUrl = ({ publicBaseUrl, mediaUrl }) => {
  const base = publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`
  return new URL(mediaUrl, base).toString()
}

const imageFilenamePattern = /\.(avif|gif|jpe?g|png|webp)$/i

export const mediaFilenameFromUrl = ({ publicBaseUrl, value }) => {
  try {
    const base = new URL(publicBaseUrl)
    const parsed = new URL(String(value), base)
    if (parsed.origin !== base.origin) return ''

    const filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    return imageFilenamePattern.test(filename) ? filename : ''
  } catch {
    return ''
  }
}

export const mediaFilenamesFromText = ({ publicBaseUrl, text }) => {
  const urlCandidates = String(text || '').match(/https?:\/\/\S+|\/\S+/g) || []
  return [...new Set(urlCandidates
    .map((candidate) => mediaFilenameFromUrl({
      publicBaseUrl,
      value: candidate.replace(/[)>.,!?]+$/, ''),
    }))
    .filter(Boolean))]
}

export const mediaFilenamesFromMessages = ({ publicBaseUrl, messages }) => (
  [...new Set(messages.flatMap((message) => mediaFilenamesFromText({
    publicBaseUrl,
    text: message.content,
  })))]
)
