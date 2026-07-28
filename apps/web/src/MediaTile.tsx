import { Music2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  MediaItem,
  SearchMediaItem,
} from '@kaatis/contracts'
import { Link, useRouter } from './router.tsx'

const MotionPreview = ({
  item,
  active,
}: {
  item: MediaItem
  active: boolean
}) => {
  const root = useRef<HTMLVideoElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!root.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const video = root.current
    const observer = new IntersectionObserver(([entry]) => {
      setNearViewport(entry.isIntersecting)
      if (entry.isIntersecting) setInitialized(true)
      if (!entry.isIntersecting) video.pause()
    }, {
      rootMargin: '240px',
    })
    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const video = root.current
    if (!video) return
    if (!active || !nearViewport) {
      video.pause()
      return
    }
    void video.play().catch(() => {})
  }, [active, nearViewport])

  return (
    <>
      <img
        className="tile-media tile-video-poster"
        src={item.preview?.src}
        srcSet={item.preview?.srcSet}
        sizes="(max-width: 600px) 45vw, (max-width: 1000px) 30vw, 22vw"
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
      />
      <video
        ref={root}
        className={`tile-media tile-video${ready ? ' is-ready' : ''}`}
        src={initialized ? item.preview?.motion : undefined}
        poster={item.preview?.src}
        muted
        loop
        playsInline
        preload="none"
        aria-label={item.name}
        onLoadedData={() => setReady(true)}
        onEmptied={() => setReady(false)}
        onError={() => setReady(false)}
      />
    </>
  )
}

export const MediaTile = ({
  item,
  active = true,
}: {
  item: MediaItem | SearchMediaItem
  active?: boolean
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
        <MotionPreview item={item} active={active} />
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
