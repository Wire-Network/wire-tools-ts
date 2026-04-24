import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  buildLineIndex,
  extendLineIndex,
  readLines
} from "@wire-e2e-tests/debugging-client-tool-tui/features/processMonitor/util/lineIndex.js"

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
