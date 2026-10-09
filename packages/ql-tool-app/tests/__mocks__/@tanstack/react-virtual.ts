/** One virtual row. */
interface MockVirtualItem {
  key: number
  index: number
  start: number
  end: number
  size: number
}

/** Options the mock reads. */
interface MockVirtualizerOptions {
  count: number
  estimateSize: () => number
}

/** Rows the mock renders (a fixed window, like a small viewport). */
export const MockWindowRows = 50

/**
 * A virtualizer that renders the first {@link MockWindowRows} rows (jsdom has no layout).
 *
 * @param options - count + estimateSize.
 * @returns The virtualizer surface the grid uses.
 */
export function useVirtualizer(options: MockVirtualizerOptions) {
  const size = options.estimateSize(),
    items: MockVirtualItem[] = Array.from({ length: Math.min(options.count, MockWindowRows) }, (_value, index) => ({
      key: index,
      index,
      start: index * size,
      end: (index + 1) * size,
      size
    }))
  return {
    getVirtualItems: () => items,
    getTotalSize: () => options.count * size,
    scrollToIndex: jest.fn()
  }
}
