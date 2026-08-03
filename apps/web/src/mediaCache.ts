import type {
  MediaItem,
  SearchMediaItem,
} from '@kaatis/contracts'

export type GalleryItem = MediaItem | SearchMediaItem

export interface MediaSnapshot {
  items: GalleryItem[]
  cursor: string | null
}

export const appendUniqueItems = (
  current: GalleryItem[],
  incoming: GalleryItem[],
) => {
  const filenames = new Set(current.map((item) => item.filename))
  return [
    ...current,
    ...incoming.filter((item) => {
      if (filenames.has(item.filename)) return false
      filenames.add(item.filename)
      return true
    }),
  ]
}

export const createMediaSnapshotCache = (limit = 20) => {
  const snapshots = new Map<string, MediaSnapshot>()

  return {
    get: (query: string) => snapshots.get(query),
    set: (query: string, snapshot: MediaSnapshot) => {
      snapshots.delete(query)
      snapshots.set(query, snapshot)
      while (snapshots.size > limit) {
        const oldest = snapshots.keys().next().value
        if (oldest === undefined) break
        snapshots.delete(oldest)
      }
    },
  }
}

export const mediaSnapshotCache = createMediaSnapshotCache()
