import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Music2,
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
} from 'react'
import type {
  MediaItem,
  SearchMediaItem,
} from '@kaatis/contracts'

import {
  getMedia,
  getSimilar,
} from './api.ts'
import { Gallery } from './Gallery.tsx'
import { useRouter } from './router.tsx'

const formatDate = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('fi-FI', {
    dateStyle: 'medium',
  }).format(date)
}

const DetailMedia = ({ item }: { item: MediaItem | SearchMediaItem }) => {
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const element = video.current
    if (!element || !('matchStartSeconds' in item)) return
    const start = item.matchStartSeconds
    if (typeof start !== 'number') return
    const seek = () => {
      element.currentTime = start
    }
    element.addEventListener('loadedmetadata', seek, { once: true })
    return () => element.removeEventListener('loadedmetadata', seek)
  }, [item])

  if (item.type === 'image') {
    return <img src={item.url} alt={item.name} />
  }
  if (item.type === 'video') {
    return (
      <video
        ref={video}
        src={item.url}
        poster={item.preview?.src}
        controls
        autoPlay
        playsInline
      />
    )
  }
  return (
    <div className="detail-audio">
      <Music2 aria-hidden="true" />
      <strong>{item.name}</strong>
      <audio src={item.url} controls autoPlay />
    </div>
  )
}

export const MediaDetail = ({ filename }: { filename: string }) => {
  let decodedFilename = ''
  try {
    decodedFilename = decodeURIComponent(filename)
  } catch {
    decodedFilename = ''
  }
  const { location, navigate } = useRouter()
  const stateItem = (
    location.state as { media?: SearchMediaItem } | null
  )?.media
  const [item, setItem] = useState<MediaItem | SearchMediaItem | null>(
    stateItem?.filename === decodedFilename ? stateItem : null,
  )
  const [similar, setSimilar] = useState<SearchMediaItem[]>([])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    if (!item || item.filename !== decodedFilename) {
      getMedia(decodedFilename, controller.signal)
        .then(setItem)
        .catch(() => navigate('/', { replace: true }))
    }
    return () => controller.abort()
  }, [decodedFilename, item, navigate])

  useEffect(() => {
    if (!item || item.type === 'audio') return
    const controller = new AbortController()
    getSimilar(item.filename, controller.signal)
      .then((response) => setSimilar(response.results))
      .catch(() => setSimilar([]))
    return () => controller.abort()
  }, [item])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if ((location.state as { from?: string } | null)?.from) navigate(-1)
        else navigate('/')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [location.state, navigate])

  if (!item) return null

  const copyUrl = async () => {
    await navigator.clipboard.writeText(
      new URL(item.url, window.location.origin).toString(),
    )
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  const matched = 'matchedModality' in item
    ? item.matchedModality
    : undefined
  const goBack = () => {
    if ((location.state as { from?: string } | null)?.from) navigate(-1)
    else navigate('/')
  }

  return (
    <main className="detail-page">
      <nav className="detail-toolbar" aria-label="Median toiminnot">
        <button
          className="icon-button"
          type="button"
          title="Takaisin"
          aria-label="Takaisin"
          onClick={goBack}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <div className="detail-actions">
          <button
            className="icon-button"
            type="button"
            title="Kopioi osoite"
            aria-label="Kopioi osoite"
            onClick={copyUrl}
          >
            {copied
              ? <Check aria-hidden="true" />
              : <Copy aria-hidden="true" />}
          </button>
          <a
            className="icon-button"
            href={item.url}
            download
            title="Lataa"
            aria-label="Lataa"
          >
            <Download aria-hidden="true" />
          </a>
        </div>
      </nav>

      <section className="detail-media">
        <DetailMedia item={item} />
      </section>

      <section className="detail-info">
        <h1>{item.name}</h1>
        <p>
          {[item.creator, formatDate(item.modified)].filter(Boolean).join(' · ')}
        </p>
        {matched === 'audio' && <span>Osuma äänestä</span>}
        {matched === 'storyboard' && <span>Osuma kuvasta</span>}
      </section>

      {similar.length > 0 && (
        <section className="similar">
          <h2>Samankaltaisia</h2>
          <Gallery items={similar} />
        </section>
      )}
    </main>
  )
}
