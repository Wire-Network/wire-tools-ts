import Fs from "node:fs"

/** Byte offsets for each line start in a file. Consumed by log-tail services in the server and the local-disk client. */
export interface LineIndex {
  path: string
  /** Inode — invalidates the index on rotation. */
  ino: number
  /**
   * `byteOffsets[i]` = byte position of line `i`. May contain one trailing
   * entry for an in-progress (partial) line if the file's last byte is not
   * `\n`. Consumers should bound their iteration by {@link completeLineCount}
   * rather than `byteOffsets.length`.
   */
  byteOffsets: number[]
  /** File size at time of last scan. */
  totalBytes: number
  /**
   * Count of lines that ended in `\n` at scan time. When the file's tail is
   * mid-write (no terminating `\n`), the renderer would otherwise treat the
   * partial bytes as a "line" — for JSONL that surfaces as a malformed-JSON
   * row at the bottom of the viewport. Servers and clients expose this as
   * the `totalLines` counter on `LogStat`, so the partial line stays hidden
   * until flushed.
   */
  completeLineCount: number
}

namespace LineIndexInternals {
  /** Stream chunk size — bounds peak resident memory while indexing a large file. */
  export const ChunkSize = 1 << 20
  /** Latin-1 / binary encoding lets us scan bytes without UTF-8 boundary risk; `\n` is byte 0x0A regardless. */
  export const ScanEncoding = "latin1" as const
  /** Global regex over `\n`; reused across every chunk. */
  export const NewlineRegex = /\n/g
  /** Newline byte (LF). Used by tail probe + post-newline arithmetic. */
  export const NewlineByte = 0x0a
  /** Newline byte length. Used when computing the next-line start. */
  export const NewlineByteLength = 1
}

/**
 * Build a full line-offset index. Streams the file in {@link LineIndexInternals.ChunkSize}
 * chunks and only retains the offset array — never the file contents — so a
 * multi-GB log no longer requires multi-GB resident memory.
 *
 * @param path absolute path of the file to index
 */
export async function buildLineIndex(path: string): Promise<LineIndex> {
  const stat = await Fs.promises.stat(path),
    byteOffsets = await streamNewlineOffsets(path, 0, stat.size, [0]),
    tailIsComplete = await tailEndsInNewline(path, stat.size),
    completeLineCount = computeCompleteLineCount(byteOffsets, tailIsComplete)
  return {
    path,
    ino: stat.ino,
    byteOffsets,
    totalBytes: stat.size,
    completeLineCount
  }
}

/**
 * Refresh the index against the current file. Short-circuits when the file
 * hasn't grown, rebuilds fully on inode change (log rotation), and otherwise
 * streams *only* the appended tail bytes — turning a hot-path 200 ms tick into
 * a constant-memory append regardless of total file size.
 *
 * When the prior tail ended in `\n` the byte position right after that newline
 * is itself the start of the first new line; seed it before streaming so it
 * isn't lost. (Build-time scans drop offsets equal to file size to avoid a
 * phantom EOF line, so this position only re-surfaces at extend time.)
 */
export async function extendLineIndex(index: LineIndex): Promise<LineIndex> {
  const stat = await Fs.promises.stat(index.path)
  if (stat.ino !== index.ino) return buildLineIndex(index.path)
  if (stat.size <= index.totalBytes) return index
  const oldTailIsNewline = await tailEndsInNewline(
      index.path,
      index.totalBytes
    ),
    seed = oldTailIsNewline
      ? [...index.byteOffsets, index.totalBytes]
      : [...index.byteOffsets],
    byteOffsets = await streamNewlineOffsets(
      index.path,
      index.totalBytes,
      stat.size,
      seed
    ),
    newTailIsComplete = await tailEndsInNewline(index.path, stat.size),
    completeLineCount = computeCompleteLineCount(byteOffsets, newTailIsComplete)
  return {
    ...index,
    byteOffsets,
    totalBytes: stat.size,
    completeLineCount
  }
}

/**
 * Number of fully-terminated lines represented by `byteOffsets`. When the
 * file's tail isn't `\n`, the final entry is the start of an in-progress
 * line and is excluded from the count (clamped at zero so an empty file
 * doesn't go negative).
 */
function computeCompleteLineCount(
  byteOffsets: number[],
  tailIsComplete: boolean
): number {
  return Math.max(0, byteOffsets.length - (tailIsComplete ? 0 : 1))
}

/** Read a single byte at `totalBytes - 1`; returns true when it's `\n` (0x0A). */
async function tailEndsInNewline(
  path: string,
  totalBytes: number
): Promise<boolean> {
  if (totalBytes <= 0) return false
  const fd = await Fs.promises.open(path, "r"),
    buf = Buffer.alloc(1)
  try {
    await fd.read(buf, 0, 1, totalBytes - 1)
  } finally {
    await fd.close()
  }
  return buf[0] === LineIndexInternals.NewlineByte
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
 * Stream `path` from `startByte` (inclusive) to `endByte` (exclusive) in chunk
 * windows, scanning each chunk for `\n` and recording the byte position of the
 * NEXT line that starts after each newline. The returned array is the
 * concatenation of `seedOffsets` with every newly-discovered offset that lies
 * strictly before `endByte` (so a trailing `\n` doesn't yield a phantom EOF
 * line).
 *
 * @param path        file to stream
 * @param startByte   inclusive start byte (use 0 for full builds)
 * @param endByte     exclusive end byte (the file size at scan time)
 * @param seedOffsets pre-existing offsets to extend (use `[0]` for full builds)
 */
function streamNewlineOffsets(
  path: string,
  startByte: number,
  endByte: number,
  seedOffsets: number[]
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (startByte >= endByte) {
      resolve([...seedOffsets])
      return
    }
    const offsets = [...seedOffsets]
    let cursor = startByte
    const stream = Fs.createReadStream(path, {
      start: startByte,
      end: endByte - 1,
      highWaterMark: LineIndexInternals.ChunkSize
    })
    stream.on("data", (chunk: Buffer | string) => {
      const buf =
        typeof chunk === "string"
          ? Buffer.from(chunk, LineIndexInternals.ScanEncoding)
          : chunk
      ;[
        ...buf
          .toString(LineIndexInternals.ScanEncoding)
          .matchAll(LineIndexInternals.NewlineRegex)
      ]
        .map(m => cursor + (m.index ?? 0) + LineIndexInternals.NewlineByteLength)
        .filter(pos => pos < endByte)
        .forEach(pos => offsets.push(pos))
      cursor += buf.length
    })
    stream.once("end", () => resolve(offsets))
    stream.once("error", reject)
  })
}
