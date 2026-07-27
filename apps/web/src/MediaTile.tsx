import { Music2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  MediaItem,
  SearchMediaItem,
} from '@kaatis/contracts'
import { Link, useRouter } from './router.tsx'

const MotionPreview = ({ item }: { item: MediaItem }) => {
  const root = useRef<HTMLVideoElement>(null)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!root.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const video = root.current
    const observer = new IntersectionObserver(([entry]) => {
      setActive(entry.isIntersecting)
      if (!entry.isIntersecting) video.pause()
    }, {
      rootMargin: '240px',
    })
    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const video = root.current
    if (!video || !active) return
    void video.play().catch(() => {})
  }, [active])

  return (
    <video
      ref={root}
      className="tile-media"
      src={active ? item.preview?.motion : undefined}
      poster={item.preview?.src}
      muted
      loop
      playsInline
      preload="none"
      aria-label={item.name}
    />
  )
}

export const MediaTile = ({
  item,
}: {
  item: MediaItem | SearchMediaItem
}) => {
  const { location } = useRouter()
  const [failed, setFailed] = useState(false)
  const hasPreview = item.previewStatus === 'ready' && item.preview

  return (
    <Link
      className="media-tile"
      to={`/m/${encodeURIComponent(item.filename)}`}
      state={{
        media: item,
        from: `${location.pathname}${location.search}`,
      }}
      aria-label={item.name}
      style={{ backgroundColor: item.dominantColor }}
    >
      {item.type === 'image' && hasPreview && !failed && (
        <img
          className="tile-media"
          src={item.preview?.src}
          srcSet={item.preview?.srcSet}
          sizes="(max-width: 600px) 45vw, (max-width: 1000px) 30vw, 22vw"
          alt={item.name}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      {item.type === 'video' && hasPreview && !failed && (
        <MotionPreview item={item} />
      )}
      {item.type === 'audio' && (
        <span className="audio-tile">
          <Music2 aria-hidden="true" />
          <span>{item.name}</span>
        </span>
      )}
      {item.type !== 'audio' && (!hasPreview || failed) && (
        <span className="preview-pending" aria-label={item.name} />
      )}
    </Link>
  )
}
