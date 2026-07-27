import type {
  MediaItem,
  MediaPage,
  SearchResponse,
  SimilarResponse,
} from '@kaatis/contracts'

const getJson = async <T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> => {
  const response = await fetch(path, { signal })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body as T
}

export const getMediaPage = (
  cursor: string | null,
  signal?: AbortSignal,
) => {
  const parameters = new URLSearchParams({ limit: '60' })
  if (cursor) parameters.set('cursor', cursor)
  return getJson<MediaPage>(`/api/media?${parameters.toString()}`, signal)
}

export const searchMedia = (query: string, signal?: AbortSignal) => {
  const parameters = new URLSearchParams({
    q: query,
    limit: '80',
  })
  return getJson<SearchResponse>(`/api/search?${parameters.toString()}`, signal)
}

export const getMedia = (filename: string, signal?: AbortSignal) => (
  getJson<MediaItem>(`/api/media/${encodeURIComponent(filename)}`, signal)
)

export const getSimilar = (filename: string, signal?: AbortSignal) => (
  getJson<SimilarResponse>(
    `/api/media/${encodeURIComponent(filename)}/similar?limit=24`,
    signal,
  )
)
