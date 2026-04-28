import React, { useEffect, useState } from "react"
import { Box } from "ink"

/**
 * Generic offset-scroll list. Renders `viewportHeight` items starting at
 * `offset`. Pattern adapted from `ink-virtual-list`'s mental model; we don't
 * take a runtime dep because that package's peer requires Ink ^6, while the
 * TUI runs on Ink 7 + React 19. Fetches only the visible window — suitable
 * for file-backed log rendering where buffering every line in memory would
 * be wasteful.
 */
export interface VirtualListProps<T> {
  /** Total item count — drives clamping and scroll-bar hints. */
  totalItems: number
  /** Top-of-viewport index (0-based). */
  offset: number
  /** How many items to render at once (must be > 0). */
  viewportHeight: number
  /** Async window fetch. Called with (from, count). */
  fetchRange: (from: number, count: number) => Promise<T[]>
  /** Render one item. Second arg is the absolute (not window-relative) index. */
  renderItem: (item: T, index: number) => React.ReactElement
}

/**
 * Virtual-scroll list based on `ink-virtual-list`'s offset model. Re-fetches
 * the window via `fetchRange` when `offset`, `viewportHeight`, or the
 * `fetchRange` identity changes.
 *
 * Items are stored alongside the offset they were fetched FOR. Until the new
 * fetch resolves, the previous snapshot keeps rendering — so a fast key
 * sequence can't blank the viewport mid-flight (any cancellation merely
 * leaves the prior, fully-fetched snapshot on screen until the latest fetch
 * lands). Callers should memoize `fetchRange` (e.g. with `useCallback`) so
 * its identity stays stable across re-renders that don't touch the data
 * source.
 */
export function VirtualList<T>(props: VirtualListProps<T>): React.ReactElement {
  const {
      totalItems,
      offset,
      viewportHeight,
      fetchRange,
      renderItem
    } = props,
    clampedOffset = Math.max(
      0,
      Math.min(offset, Math.max(0, totalItems - viewportHeight))
    ),
    [snapshot, setSnapshot] = useState<{ items: T[]; offset: number }>({
      items: [],
      offset: 0
    })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const fetched = await fetchRange(clampedOffset, viewportHeight)
      if (!cancelled) setSnapshot({ items: fetched, offset: clampedOffset })
    })()
    return () => {
      cancelled = true
    }
  }, [clampedOffset, viewportHeight, fetchRange])

  return (
    <Box flexDirection="column">
      {snapshot.items.map((it, i) => renderItem(it, snapshot.offset + i))}
    </Box>
  )
}
