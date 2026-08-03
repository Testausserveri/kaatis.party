export type MediaType = 'image' | 'video' | 'audio'

export type PreviewStatus = 'pending' | 'ready' | 'failed'

export interface MediaPreview {
  src: string
  srcSet: string
  motion?: string
}

export interface MediaItem {
  filename: string
  type: MediaType
  name: string
  url: string
  creator: string
  modified: string
  extension: string
  fileSize: number
  width: number
  height: number
  durationMs: number
  dominantColor: string
  previewStatus: PreviewStatus
  preview?: MediaPreview
}

export interface SearchMediaItem extends MediaItem {
  score: number
  similarityScore?: number
  matchedModality?: 'image' | 'storyboard' | 'audio' | 'mixed'
  matchStartSeconds?: number
  matchEndSeconds?: number
  embeddingTruncated?: boolean
}

export interface MediaPage {
  count: number
  nextCursor: string | null
  results: MediaItem[]
}

export interface SearchResponse {
  query: string
  count: number
  nextCursor: string | null
  degraded: boolean
  results: SearchMediaItem[]
}

export interface SimilarResponse {
  filename: string
  count: number
  results: SearchMediaItem[]
}

export interface InternalUploadRequest {
  sourceUrl: string
  originalFilename: string
  requestedName: string
  creator: string
  modified: string
  discordMessageId: string
}

export interface InternalUploadResponse {
  status: 'accepted'
  media: MediaItem
}
