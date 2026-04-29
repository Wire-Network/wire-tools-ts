import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  buildLineIndex,
  extendLineIndex,
  readLines
} from "@wireio/debugging-client-tool-tui/features/process-monitor/util/lineIndex.js"

function writeFixture(root: string, name: string, contents: string): string {
  const file = Path.join(root, name)
  Fs.writeFileSync(file, contents)
  return file
}

describe("buildLineIndex", () => {
  let root: string

  beforeEach(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "line-index-"))
  })

  afterEach(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  it("indexes an empty file with a single byte-0 offset", async () => {
    const file = writeFixture(root, "empty.log", "")
    const idx = await buildLineIndex(file)
    expect(idx.byteOffsets).toEqual([0])
    expect(idx.totalBytes).toBe(0)
  })

  it("indexes a 3-line ASCII file with correct offsets", async () => {
    const file = writeFixture(root, "three.log", "aaa\nbb\nc\n")
    const idx = await buildLineIndex(file)
    expect(idx.byteOffsets).toEqual([0, 4, 7])
  })

  it("handles a file without a trailing newline", async () => {
    const file = writeFixture(root, "notrail.log", "foo\nbar")
    const idx = await buildLineIndex(file)
    expect(idx.byteOffsets).toEqual([0, 4])
  })

  it("accounts for multi-byte UTF-8", async () => {
    const file = writeFixture(root, "utf8.log", "α\nβ\n")
    const idx = await buildLineIndex(file)
    expect(idx.byteOffsets).toEqual([0, 3])
  })

  it("completeLineCount excludes the trailing partial line when no terminating \\n", async () => {
    const file = writeFixture(root, "partial.log", "foo\nbar\nbaz")
    const idx = await buildLineIndex(file)
    // byteOffsets retains the partial-line start internally, but the count of
    // complete (rendered) lines is 2 — "foo" and "bar". "baz" is in flight.
    expect(idx.byteOffsets).toEqual([0, 4, 8])
    expect(idx.completeLineCount).toBe(2)
  })

  it("completeLineCount equals byteOffsets.length when the file ends in \\n", async () => {
    const file = writeFixture(root, "complete.log", "a\nb\nc\n")
    const idx = await buildLineIndex(file)
    expect(idx.byteOffsets).toEqual([0, 2, 4])
    expect(idx.completeLineCount).toBe(3)
  })

  it("completeLineCount is 0 for an empty file (no lines yet)", async () => {
    const file = writeFixture(root, "empty.log", "")
    const idx = await buildLineIndex(file)
    expect(idx.completeLineCount).toBe(0)
  })

  it("completeLineCount is 0 for a file with content but no \\n yet", async () => {
    const file = writeFixture(root, "nonl.log", "still being written")
    const idx = await buildLineIndex(file)
    expect(idx.completeLineCount).toBe(0)
  })

  it("streams a multi-chunk file without buffering it whole", async () => {
    // Build a fixture larger than the 1 MiB scan-chunk boundary so the
    // streaming path executes the multi-`data`-event branch and we exercise
    // cross-chunk offset arithmetic.
    const lineBody = "x".repeat(127),
      lineCount = 20_000,
      contents = `${lineBody}\n`.repeat(lineCount),
      file = writeFixture(root, "big.log", contents)
    const idx = await buildLineIndex(file)
    expect(idx.totalBytes).toBe(contents.length)
    expect(idx.byteOffsets.length).toBe(lineCount)
    expect(idx.byteOffsets[0]).toBe(0)
    // Each line is 128 bytes (127 body + 1 newline); offset n = n * 128.
    expect(idx.byteOffsets[1]).toBe(128)
    expect(idx.byteOffsets[lineCount - 1]).toBe((lineCount - 1) * 128)
  })
})

describe("extendLineIndex", () => {
  let root: string

  beforeEach(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "line-index-ext-"))
  })

  afterEach(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  it("is a no-op when file size unchanged", async () => {
    const file = writeFixture(root, "t.log", "a\nb\n")
    const idx = await buildLineIndex(file)
    const next = await extendLineIndex(idx)
    expect(next).toBe(idx)
  })

  it("picks up newly-appended lines without rebuild", async () => {
    const file = writeFixture(root, "t.log", "a\nb\n")
    let idx = await buildLineIndex(file)
    Fs.appendFileSync(file, "c\nd\n")
    idx = await extendLineIndex(idx)
    expect(idx.byteOffsets).toEqual([0, 2, 4, 6])
  })

  it("rebuilds on inode change (log rotation)", async () => {
    const file = writeFixture(root, "t.log", "a\n")
    const original = await buildLineIndex(file)
    // Simulate rotation: move + re-create.
    Fs.renameSync(file, file + ".1")
    Fs.writeFileSync(file, "xx\nyy\nzz\n")
    const next = await extendLineIndex(original)
    expect(next.ino).not.toBe(original.ino)
    expect(next.byteOffsets).toEqual([0, 3, 6])
  })

  it("completeLineCount tracks across writes that complete a partial line", async () => {
    const file = writeFixture(root, "t.log", "alpha\nbet")
    let idx = await buildLineIndex(file)
    expect(idx.completeLineCount).toBe(1)
    Fs.appendFileSync(file, "a\n")
    idx = await extendLineIndex(idx)
    // The "bet" + "a\n" append completes line 1 ("beta"); count goes 1 → 2.
    expect(idx.completeLineCount).toBe(2)
  })

  it("completeLineCount drops the new partial when an append also leaves an unterminated tail", async () => {
    const file = writeFixture(root, "t.log", "alpha\n")
    let idx = await buildLineIndex(file)
    expect(idx.completeLineCount).toBe(1)
    Fs.appendFileSync(file, "beta")
    idx = await extendLineIndex(idx)
    // "beta" has no trailing \n yet — still only 1 complete line.
    expect(idx.completeLineCount).toBe(1)
  })

  it("streams only the appended tail on growth", async () => {
    // Pre-existing offset list survives — we don't rebuild from scratch.
    const file = writeFixture(root, "t.log", "alpha\nbeta\n")
    const initial = await buildLineIndex(file)
    expect(initial.byteOffsets).toEqual([0, 6])
    Fs.appendFileSync(file, "gamma\ndelta\n")
    const grown = await extendLineIndex(initial)
    // First two offsets are the SAME array references (we extend, not rebuild).
    expect(grown.byteOffsets.slice(0, 2)).toEqual(initial.byteOffsets)
    expect(grown.byteOffsets).toEqual([0, 6, 11, 17])
    expect(grown.totalBytes).toBe(initial.totalBytes + 12)
  })
})

describe("readLines", () => {
  let root: string

  beforeEach(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "line-index-read-"))
  })

  afterEach(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  it("returns a [from, from+count) slice", async () => {
    const file = writeFixture(root, "t.log", "a\nb\nc\nd\n")
    const idx = await buildLineIndex(file)
    expect(await readLines(idx, 1, 2)).toEqual(["b", "c"])
  })

  it("returns [] when from is past the last line", async () => {
    const file = writeFixture(root, "t.log", "a\n")
    const idx = await buildLineIndex(file)
    expect(await readLines(idx, 10, 5)).toEqual([])
  })

  it("clamps count to remaining lines", async () => {
    const file = writeFixture(root, "t.log", "a\nb\n")
    const idx = await buildLineIndex(file)
    expect(await readLines(idx, 0, 100)).toEqual(["a", "b"])
  })
})
