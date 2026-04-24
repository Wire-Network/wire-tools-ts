import Fs from "node:fs"

/** Byte offsets for each line start in a file. Used by `LogTailingService`. */
export interface LineIndex {
  path: string
  /** Inode — invalidates the index on rotation. */
  ino: number
  /** `byteOffsets[i]` = byte position of line `i`. */
  byteOffsets: number[]
  /** File size at time of last scan. */
  totalBytes: number
}

/** Build a full line-offset index. O(n) in file size; whole file read into memory. */
export async function buildLineIndex(path: string): Promise<LineIndex> {
  const [stat, text] = await Promise.all([
    Fs.promises.stat(path),
    Fs.promises.readFile(path, "utf8")
  ])
  const byteOffsets = appendOffsets([0], 0, text, stat.size)
  return { path, ino: stat.ino, byteOffsets, totalBytes: stat.size }
}

/**
 * Refresh the index against the current file. Short-circuits when the file
 * hasn't grown, and rebuilds fully on inode change (log rotation) or growth.
 *
 * We intentionally rebuild on every growth rather than incrementally extending:
 * an incremental extension has to know whether the previous tail ended in `\n`
 * and whether an already-indexed final line is now continued — tracking that
 * state as an invariant is error-prone. Rebuilding a multi-MB log is milliseconds.
 */
export async function extendLineIndex(index: LineIndex): Promise<LineIndex> {
  const stat = await Fs.promises.stat(index.path)
  if (stat.ino !== index.ino) return buildLineIndex(index.path)
  if (stat.size <= index.totalBytes) return index
  return buildLineIndex(index.path)
}

/**
 * Read `count` lines starting at `from`. Respects the byte offsets in the
 * index — callers should request [from, from+count) windows.
 */
export async function readLines(
  index: LineIndex,
  from: number,
  count: number
): Promise<string[]> {
  const start = index.byteOffsets[from] ?? index.totalBytes,
    end = index.byteOffsets[from + count] ?? index.totalBytes
  if (start >= end) return []
  const fd = await Fs.promises.open(index.path, "r"),
    buf = Buffer.alloc(end - start)
  try {
    await fd.read(buf, 0, end - start, start)
  } finally {
    await fd.close()
  }
  const text = buf.toString("utf8")
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
}

/**
 * Append line-start byte offsets discovered by scanning `text` (beginning at
 * file offset `fromByte`). Mutates `offsets` in place and returns it for
 * chain-ability.
 *
 * @param offsets existing offset list (already contains 0 for first-line start)
 * @param fromByte absolute byte position where `text` begins in the file
 * @param text freshly-read text chunk
 * @param totalBytes size of the file at time of scan (bound for final offset)
 */
function appendOffsets(
  offsets: number[],
  fromByte: number,
  text: string,
  totalBytes: number
): number[] {
  // Track cumulative byte count across the chunk; append an offset at the
  // byte AFTER each newline that is not the final byte of the file.
  const parts = text.split("\n")
  let byteCursor = fromByte
  parts.slice(0, -1).forEach(part => {
    byteCursor += Buffer.byteLength(part + "\n", "utf8")
    if (byteCursor < totalBytes) offsets.push(byteCursor)
  })
  return offsets
}
