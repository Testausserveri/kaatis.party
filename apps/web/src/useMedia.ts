import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MediaItem,
  SearchMediaItem,
} from '@kaatis/contracts'

import {
  getMediaPage,
  searchMedia,
} from './api.ts'

export const useMedia = (query: string) => {
  const [items, setItems] = useState<(MediaItem | SearchMediaItem)[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)
  const normalizedQuery = query.trim()

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
      setItems((current) => replace
        ? page.results
        : [...current, ...page.results])
      setCursor(page.nextCursor)
    } catch (currentError) {
      if ((currentError as Error).name !== 'AbortError') setError(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [normalizedQuery])

  useEffect(() => {
    request.current?.abort()

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
