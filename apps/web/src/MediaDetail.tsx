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

const DetailImage = ({ item }: { item: MediaItem | SearchMediaItem }) => {
  const [loaded, setLoaded] = useState(false)
  const hasPreview = Boolean(item.preview?.src)

  const reveal = (image: HTMLImageElement) => {
    void image.decode()
      .catch(() => undefined)
      .then(() => setLoaded(true))
  }

  return (
    <div
      className={[
        'detail-image',
        hasPreview ? 'has-preview' : '',
        loaded ? 'is-loaded' : '',
      ].filter(Boolean).join(' ')}
    >
      {hasPreview && (
        <img
          className="detail-image-preview"
          src={item.preview?.src}
          srcSet={item.preview?.srcSet}
          sizes="100vw"
          width={item.width || undefined}
          height={item.height || undefined}
          alt=""
          aria-hidden="true"
        />
      )}
      <img
        className="detail-image-original"
        src={item.url}
        width={item.width || undefined}
        height={item.height || undefined}
        alt={item.name}
        decoding="async"
        fetchPriority="high"
        onLoad={(event) => reveal(event.currentTarget)}
      />
    </div>
  )
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
    return <DetailImage key={item.url} item={item} />
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

const stateRecord = (state: unknown): Record<string, unknown> => (
  state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
)

const ignoresGalleryArrows = (target: EventTarget | null) => (
  target instanceof HTMLInputElement
  || target instanceof HTMLTextAreaElement
  || target instanceof HTMLSelectElement
  || target instanceof HTMLMediaElement
  || (target instanceof HTMLElement && target.isContentEditable)
)

export const MediaDetail = ({
  filename,
  navigationItems,
}: {
  filename: string
  navigationItems: (MediaItem | SearchMediaItem)[]
}) => {
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
  const [fetchedItem, setFetchedItem] = useState<MediaItem | null>(null)
  const item = stateItem?.filename === decodedFilename
    ? stateItem
    : fetchedItem?.filename === decodedFilename
      ? fetchedItem
      : null
  const [similar, setSimilar] = useState<SearchMediaItem[]>([])
  const [copied, setCopied] = useState(false)
  const detailRoot = useRef<HTMLElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    if (!item) {
      getMedia(decodedFilename, controller.signal)
        .then(setFetchedItem)
        .catch(() => navigate('/', { replace: true }))
    }
    return () => controller.abort()
  }, [decodedFilename, item, navigate])

  useEffect(() => {
    setSimilar([])
    if (!item || item.type === 'audio') return
    const controller = new AbortController()
    getSimilar(item.filename, controller.signal)
      .then((response) => setSimilar(response.results))
      .catch(() => setSimilar([]))
    return () => controller.abort()
  }, [item])

  useEffect(() => {
    detailRoot.current?.scrollTo({ top: 0 })
  }, [decodedFilename])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if ((location.state as { from?: string } | null)?.from) navigate(-1)
        else navigate('/')
        return
      }

      if (
        !['ArrowLeft', 'ArrowRight'].includes(event.key)
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || ignoresGalleryArrows(event.target)
      ) return

      const currentIndex = navigationItems.findIndex(
        (candidate) => candidate.filename === decodedFilename,
      )
      if (currentIndex < 0) return
      const offset = event.key === 'ArrowLeft' ? -1 : 1
      const next = navigationItems[currentIndex + offset]
      if (!next) return

      event.preventDefault()
      navigate(`/m/${encodeURIComponent(next.filename)}`, {
        replace: true,
        state: {
          ...stateRecord(location.state),
          media: next,
        },
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [decodedFilename, location.state, navigate, navigationItems])

  if (!item) return null

  const copyUrl = async () => {
    await navigator.clipboard.writeText(
      new URL(item.url, window.location.origin).toString(),
    )
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  const goBack = () => {
    if ((location.state as { from?: string } | null)?.from) navigate(-1)
    else navigate('/')
  }

  return (
    <main ref={detailRoot} className="detail-page">
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
