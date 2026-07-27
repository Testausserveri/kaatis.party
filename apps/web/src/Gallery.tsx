import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type {
  MediaItem,
  SearchMediaItem,
} from '@kaatis/contracts'

import { MediaTile } from './MediaTile.tsx'
import { useJustifiedRows } from './useJustifiedRows.ts'

export const Gallery = ({
  items,
  loading = false,
  error = false,
  hasMore = false,
  loadMore,
}: {
  items: (MediaItem | SearchMediaItem)[]
  loading?: boolean
  error?: boolean
  hasMore?: boolean
  loadMore?: () => void
}) => {
  const { root, rows } = useJustifiedRows(items)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sentinel.current || !hasMore || !loadMore) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadMore()
    }, {
      rootMargin: '800px',
    })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [hasMore, loadMore])

  return (
    <div ref={root} className="gallery">
      {rows.map((row) => (
        <div
          className="gallery-row"
          key={row.map(({ media }) => media.filename).join('\0')}
        >
          {row.map(({ media, width, height }) => (
            <div
              className="gallery-cell"
              key={media.filename}
              style={{
                width,
                height,
                flexGrow: width,
              }}
            >
              <MediaTile item={media} />
            </div>
          ))}
        </div>
      ))}
      <div ref={sentinel} className="gallery-sentinel" />
      {loading && (
        <div className="gallery-state" aria-label="Ladataan">
          <LoaderCircle className="spin" aria-hidden="true" />
        </div>
      )}
      {!loading && error && (
        <p className="gallery-state">Haku ei juuri nyt toimi</p>
      )}
      {!loading && !error && items.length === 0 && (
        <p className="gallery-state">Ei osumia</p>
      )}
    </div>
  )
}
