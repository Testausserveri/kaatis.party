import {
  useEffect,
  useLayoutEffect,
  useState,
} from 'react'

import { Gallery } from './Gallery.tsx'
import { Header } from './Header.tsx'
import { MediaDetail } from './MediaDetail.tsx'
import { useRouter } from './router.tsx'
import { useMedia } from './useMedia.ts'

const GalleryPage = ({ active }: { active: boolean }) => {
  const { location, navigate } = useRouter()
  const [query, setQuery] = useState(
    () => new URLSearchParams(location.search).get('q') || '',
  )
  const media = useMedia(query, active)

  useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => {
      const parameters = new URLSearchParams()
      if (query.trim()) parameters.set('q', query.trim())
      const search = parameters.toString()
      const target = search ? `/?${search}` : '/'
      if (`${location.pathname}${location.search}` !== target) {
        navigate(target, { replace: true })
      }
    }, 600)
    return () => window.clearTimeout(timer)
  }, [active, location.pathname, location.search, navigate, query])

  return (
    <div
      className={active ? 'gallery-view' : 'gallery-view is-suspended'}
      aria-hidden={active ? undefined : true}
      inert={active ? undefined : true}
    >
      <Header query={query} onQueryChange={setQuery} />
      <main className="gallery-page">
        <Gallery
          items={media.items}
          loading={media.loading}
          error={media.error}
          hasMore={media.hasMore}
          loadMore={media.loadMore}
          active={active}
        />
      </main>
    </div>
  )
}

export const App = () => (
  <CurrentPage />
)

const CurrentPage = () => {
  const { location } = useRouter()
  const detailFilename = location.pathname.startsWith('/m/')
    ? location.pathname.slice(3)
    : null
  const detailOpen = detailFilename !== null

  useLayoutEffect(() => {
    if (!detailOpen) return
    const root = document.documentElement
    const scrollbarWidth = window.innerWidth - root.clientWidth
    root.style.setProperty(
      '--kaatis-scrollbar-width',
      `${Math.max(0, scrollbarWidth)}px`,
    )
    root.classList.add('detail-open')
    return () => {
      root.classList.remove('detail-open')
      root.style.removeProperty('--kaatis-scrollbar-width')
    }
  }, [detailOpen])

  return (
    <>
      <GalleryPage active={!detailOpen} />
      {detailFilename !== null && <MediaDetail filename={detailFilename} />}
    </>
  )
}
