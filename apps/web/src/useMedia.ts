import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MediaItem,
  SearchMediaItem,
} from '@kaatis/contracts'

import {
  getMediaPage,
  searchMedia,
} from './api.ts'

type GalleryItem = MediaItem | SearchMediaItem

interface MediaSnapshot {
  items: GalleryItem[]
  cursor: string | null
}

const cache = new Map<string, MediaSnapshot>()
const cacheLimit = 20

const cachedSnapshot = (query: string) => cache.get(query)

const storeSnapshot = (query: string, snapshot: MediaSnapshot) => {
  cache.delete(query)
  cache.set(query, snapshot)
  while (cache.size > cacheLimit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export const useMedia = (query: string) => {
  const normalizedQuery = query.trim()
  const initial = cachedSnapshot(normalizedQuery)
  const [items, setItems] = useState<GalleryItem[]>(initial?.items || [])
  const [cursor, setCursor] = useState<string | null>(initial?.cursor || null)
  const [loading, setLoading] = useState(!initial)
  const [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)

  const loadPage = useCallback(async (
    nextCursor: string | null,
    replace: boolean,
  ) => {
    if (normalizedQuery) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(false)
    try {
      const page = await getMediaPage(nextCursor, controller.signal)
      setItems((current) => {
        const nextItems = replace
          ? page.results
          : [...current, ...page.results]
        storeSnapshot(normalizedQuery, {
          items: nextItems,
          cursor: page.nextCursor,
        })
        return nextItems
      })
      setCursor(page.nextCursor)
    } catch (currentError) {
      if ((currentError as Error).name !== 'AbortError') setError(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [normalizedQuery])

  useEffect(() => {
    request.current?.abort()

    const cached = cachedSnapshot(normalizedQuery)
    if (cached) {
      setItems(cached.items)
      setCursor(cached.cursor)
      setLoading(false)
      setError(false)
      return
    }

    if (!normalizedQuery) {
      setItems([])
      setCursor(null)
      void loadPage(null, true)
      return
    }

    if (normalizedQuery.length < 2) {
      setItems([])
      setCursor(null)
      setLoading(false)
      setError(false)
      return
    }

    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(false)
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchMedia(normalizedQuery, controller.signal)
        setItems(result.results)
        setCursor(null)
        storeSnapshot(normalizedQuery, {
          items: result.results,
          cursor: null,
        })
      } catch (currentError) {
        if ((currentError as Error).name !== 'AbortError') setError(true)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 600)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadPage, normalizedQuery])

  const loadMore = useCallback(() => {
    if (!loading && cursor && !normalizedQuery) {
      void loadPage(cursor, false)
    }
  }, [cursor, loadPage, loading, normalizedQuery])

  return {
    items,
    loading,
    error,
    hasMore: Boolean(cursor) && !normalizedQuery,
    loadMore,
  }
}
