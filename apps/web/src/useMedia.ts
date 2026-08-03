import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getMediaPage,
  searchMedia,
} from './api.ts'
import {
  appendUniqueItems,
  mediaSnapshotCache,
  type GalleryItem,
} from './mediaCache.ts'

export const useMedia = (query: string, enabled = true) => {
  const normalizedQuery = query.trim()
  const initial = mediaSnapshotCache.get(normalizedQuery)
  const [items, setItems] = useState<GalleryItem[]>(initial?.items || [])
  const [cursor, setCursor] = useState<string | null>(initial?.cursor || null)
  const [loading, setLoading] = useState(!initial)
  const [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)

  const loadPage = useCallback(async (
    nextCursor: string | null,
    replace: boolean,
  ) => {
    if (!enabled) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(false)
    try {
      const page = normalizedQuery
        ? await searchMedia(normalizedQuery, nextCursor, controller.signal)
        : await getMediaPage(nextCursor, controller.signal)
      setItems((current) => {
        const nextItems = replace
          ? page.results
          : appendUniqueItems(current, page.results)
        mediaSnapshotCache.set(normalizedQuery, {
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
  }, [enabled, normalizedQuery])

  useEffect(() => {
    request.current?.abort()

    if (!enabled) {
      setLoading(false)
      return
    }

    const cached = mediaSnapshotCache.get(normalizedQuery)
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

    setItems([])
    setCursor(null)
    setLoading(true)
    setError(false)
    const timer = window.setTimeout(() => {
      void loadPage(null, true)
    }, 600)

    return () => {
      window.clearTimeout(timer)
      request.current?.abort()
    }
  }, [enabled, loadPage, normalizedQuery])

  const loadMore = useCallback(() => {
    if (enabled && !loading && !error && cursor) {
      void loadPage(cursor, false)
    }
  }, [cursor, enabled, error, loadPage, loading])

  return {
    items,
    loading,
    error,
    hasMore: Boolean(cursor) && !error,
    loadMore,
  }
}
