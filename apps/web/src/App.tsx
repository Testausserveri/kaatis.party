import {
  useEffect,
  useState,
} from 'react'

import { Gallery } from './Gallery.tsx'
import { Header } from './Header.tsx'
import { MediaDetail } from './MediaDetail.tsx'
import { useRouter } from './router.tsx'
import { useMedia } from './useMedia.ts'

const GalleryPage = () => {
  const { location, navigate } = useRouter()
  const [query, setQuery] = useState(
    () => new URLSearchParams(location.search).get('q') || '',
  )
  const media = useMedia(query)

  useEffect(() => {
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
  }, [location.pathname, location.search, navigate, query])

  return (
    <>
      <Header query={query} onQueryChange={setQuery} />
      <main className="gallery-page">
        <Gallery
          items={media.items}
          loading={media.loading}
          error={media.error}
          hasMore={media.hasMore}
          loadMore={media.loadMore}
        />
      </main>
    </>
  )
}

export const App = () => (
  <CurrentPage />
)

const CurrentPage = () => {
  const { location } = useRouter()
  if (location.pathname.startsWith('/m/')) {
    return <MediaDetail filename={location.pathname.slice(3)} />
  }
  return <GalleryPage />
}
