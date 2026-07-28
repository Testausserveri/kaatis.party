type SortColumn = 'N' | 'M' | 'S' | 'D'
type SortOrder = 'A' | 'D'

interface LegacyRow {
  filename: string
  creator: string
  media_type: 'image' | 'video' | 'audio'
  file_size: number
  file_mtime_ms: number
  modified: string
}

interface LegacyStore {
  legacyMediaRevision: () => Record<string, unknown> | undefined
  listMedia: () => Record<string, unknown>[]
}

interface SortOptions {
  column: SortColumn
  order: SortOrder
}

const mediaTypes = new Set(['image', 'video', 'audio'])

const htmlEscape = (value: unknown) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

const filenameCompare = (left: string, right: string) => (
  Buffer.compare(Buffer.from(left), Buffer.from(right))
)

const legacyRow = (row: Record<string, unknown>): LegacyRow | null => {
  const mediaType = String(row.media_type || '')
  if (!mediaTypes.has(mediaType)) return null
  return {
    filename: String(row.filename || ''),
    creator: String(row.creator || ''),
    media_type: mediaType as LegacyRow['media_type'],
    file_size: Number(row.file_size) || 0,
    file_mtime_ms: Number(row.file_mtime_ms) || 0,
    modified: String(row.modified || ''),
  }
}

const parseSortOptions = (rawUrl: string): SortOptions => {
  const query = rawUrl.split('?', 2)[1] || ''
  const values = new Map(
    query
      .split(/[;&]/)
      .map((part) => part.split('=', 2))
      .filter((part) => part.length === 2)
      .map(([key, value]) => [key.toUpperCase(), value.toUpperCase()]),
  )
  const column = values.get('C')
  const order = values.get('O')

  return {
    column: ['N', 'M', 'S', 'D'].includes(column || '')
      ? column as SortColumn
      : 'M',
    order: order === 'A' ? 'A' : 'D',
  }
}

const rowTimestamp = (row: LegacyRow) => {
  const fileTimestamp = Number(row.file_mtime_ms)
  if (Number.isFinite(fileTimestamp) && fileTimestamp > 0) {
    return fileTimestamp
  }
  const modifiedTimestamp = Date.parse(row.modified)
  return Number.isFinite(modifiedTimestamp) ? modifiedTimestamp : 0
}

const rowValueCompare = (
  left: LegacyRow,
  right: LegacyRow,
  column: SortColumn,
) => {
  if (column === 'N') return filenameCompare(left.filename, right.filename)
  if (column === 'M') return rowTimestamp(left) - rowTimestamp(right)
  if (column === 'S') return Number(left.file_size) - Number(right.file_size)
  return filenameCompare(left.creator || '', right.creator || '')
}

const sortRows = (rows: LegacyRow[], options: SortOptions) => (
  [...rows].sort((left, right) => {
    const primary = rowValueCompare(left, right, options.column)
    if (primary !== 0) return options.order === 'A' ? primary : -primary
    return filenameCompare(left.filename, right.filename)
  })
)

const formatDate = (row: LegacyRow) => {
  const timestamp = rowTimestamp(row)
  if (!timestamp) return ''
  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')
}

const formatSize = (rawSize: number) => {
  let size = Math.max(0, Math.trunc(Number(rawSize) || 0))
  if (size < 973) return `${String(size).padStart(3, ' ')} `

  const units = 'KMGTPE'
  for (const unit of units) {
    const remainder = size % 1024
    size = Math.floor(size / 1024)

    if (size >= 973) continue
    if (size < 9 || (size === 9 && remainder < 973)) {
      let decimal = Math.floor(((remainder * 5) + 256) / 512)
      if (decimal >= 10) {
        size += 1
        decimal = 0
      }
      return `${size}.${decimal}${unit}`
    }
    if (remainder >= 512) size += 1
    return `${String(size).padStart(3, ' ')}${unit}`
  }

  return '****'
}

const iconFor = (mediaType: LegacyRow['media_type']) => {
  if (mediaType === 'video') {
    return { filename: 'movie.gif', alt: '[VID]' }
  }
  if (mediaType === 'audio') {
    return { filename: 'sound2.gif', alt: '[SND]' }
  }
  return { filename: 'image2.gif', alt: '[IMG]' }
}

const header = ({ order }: SortOptions) => {
  const nextOrder = order === 'D' ? 'A' : 'D'
  return [
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">',
    '<html>',
    ' <head>',
    '  <title>Index of /</title>',
    ' </head>',
    ' <body>',
    '<h1>Index of /</h1>',
    '  <table>',
    `   <tr><th valign="top"><img src="/icons/blank.gif" alt="[ICO]"></th><th><a href="?C=N;O=${nextOrder}">Name</a></th><th><a href="?C=M;O=${nextOrder}">Last modified</a></th><th><a href="?C=S;O=${nextOrder}">Size</a></th><th><a href="?C=D;O=${nextOrder}">Description</a></th></tr>`,
    '   <tr><th colspan="5"><hr></th></tr>',
  ]
}

const renderRow = (row: LegacyRow) => {
  const icon = iconFor(row.media_type)
  const filename = htmlEscape(row.filename)
  const creator = row.creator ? htmlEscape(row.creator) : '&nbsp;'
  return `<tr><td valign="top"><img src="/icons/${icon.filename}" alt="${icon.alt}"></td><td><a href="${encodeURIComponent(row.filename)}">${filename}</a></td><td align="right">${formatDate(row)}  </td><td align="right">${formatSize(row.file_size)}</td><td>${creator}</td></tr>`
}

const renderDocument = (rows: LegacyRow[], options: SortOptions) => [
  ...header(options),
  ...sortRows(rows, options).map(renderRow),
  '   <tr><th colspan="5"><hr></th></tr>',
  '</table>',
  '<address>Apache Server at old.kaatis.party Port 443</address>',
  '</body></html>',
  '',
].join('\n')

export const createLegacyIndex = (store: LegacyStore) => {
  let revision = ''
  const cache = new Map<string, string>()

  return {
    render: (rawUrl: string) => {
      const current = store.legacyMediaRevision() || {}
      const nextRevision = `${Number(current.count) || 0}:${String(current.updated_at || '')}`
      if (nextRevision !== revision) {
        revision = nextRevision
        cache.clear()
      }

      const options = parseSortOptions(rawUrl)
      const cacheKey = `${options.column}:${options.order}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const rows = store.listMedia()
        .map(legacyRow)
        .filter((row): row is LegacyRow => Boolean(row?.filename))
      const document = renderDocument(rows, options)
      cache.set(cacheKey, document)
      return document
    },
  }
}
