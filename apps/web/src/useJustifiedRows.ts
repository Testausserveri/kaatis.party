import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MediaItem,
  SearchMediaItem,
} from '@kaatis/contracts'

export interface LayoutItem {
  media: MediaItem | SearchMediaItem
  width: number
  height: number
}

export type LayoutRow = LayoutItem[]

const aspectRatio = (item: MediaItem | SearchMediaItem) => {
  const width = item.width || 4
  const height = item.height || 3
  return Math.max(0.25, Math.min(4, width / height))
}

const targetHeight = (width: number) => {
  if (width <= 600) return 120
  if (width <= 1000) return 160
  return 220
}

const buildRows = (
  media: (MediaItem | SearchMediaItem)[],
  containerWidth: number,
  gap: number,
) => {
  if (containerWidth <= 0) return []
  const target = targetHeight(containerWidth)
  const rows: LayoutRow[] = []
  let pending: (MediaItem | SearchMediaItem)[] = []
  let ratioSum = 0

  const flush = (isLast: boolean) => {
    if (pending.length === 0) return
    const available = containerWidth - gap * (pending.length - 1)
    const exactHeight = available / ratioSum
    const rowHeight = isLast
      ? Math.min(target, exactHeight)
      : Math.max(target * 0.72, Math.min(target * 1.28, exactHeight))
    rows.push(pending.map((item) => ({
      media: item,
      width: Math.max(1, aspectRatio(item) * rowHeight),
      height: rowHeight,
    })))
    pending = []
    ratioSum = 0
  }

  media.forEach((item) => {
    pending.push(item)
    ratioSum += aspectRatio(item)
    const projected = ratioSum * target + gap * (pending.length - 1)
    if (projected >= containerWidth) flush(false)
  })
  flush(true)
  return rows
}

export const useJustifiedRows = (
  media: (MediaItem | SearchMediaItem)[],
  gap = 4,
) => {
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])

  const rows = useMemo(
    () => buildRows(media, width, gap),
    [gap, media, width],
  )

  return {
    root,
    rows,
  }
}
