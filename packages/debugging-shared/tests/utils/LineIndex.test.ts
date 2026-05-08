import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  buildLineIndex,
  extendLineIndex,
  readLines
} from "@wireio/debugging-shared"

describe("LineIndex", () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = Fs.mkdtempSync(Path.join(OS.tmpdir(), "lineindex-"))
    logPath = Path.join(tmpDir, "log.txt")
  })

  afterEach(() => {
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("indexes a fully-terminated file", async () => {
    Fs.writeFileSync(logPath, "alpha\nbeta\ngamma\n", "utf8")
    const idx = await buildLineIndex(logPath)
    expect(idx.completeLineCount).toBe(3)
    expect(idx.totalBytes).toBe(17)
    expect(await readLines(idx, 0, 3)).toEqual(["alpha", "beta", "gamma"])
  })

  it("excludes a partial trailing line from completeLineCount", async () => {
    Fs.writeFileSync(logPath, "alpha\nbeta", "utf8")
    const idx = await buildLineIndex(logPath)
    expect(idx.completeLineCount).toBe(1)
    expect(await readLines(idx, 0, 1)).toEqual(["alpha"])
  })

  it("returns the empty array for an empty file", async () => {
    Fs.writeFileSync(logPath, "", "utf8")
    const idx = await buildLineIndex(logPath)
    expect(idx.completeLineCount).toBe(0)
    expect(await readLines(idx, 0, 5)).toEqual([])
  })

  it("extends incrementally when the file grows", async () => {
    Fs.writeFileSync(logPath, "alpha\nbeta\n", "utf8")
    const initial = await buildLineIndex(logPath)
    expect(initial.completeLineCount).toBe(2)

    Fs.appendFileSync(logPath, "gamma\n", "utf8")
    const next = await extendLineIndex(initial)
    expect(next.completeLineCount).toBe(3)
    expect(next.ino).toBe(initial.ino)
    expect(await readLines(next, 2, 1)).toEqual(["gamma"])
  })

  it("rebuilds fully on inode change (rotation)", async () => {
    Fs.writeFileSync(logPath, "alpha\n", "utf8")
    const initial = await buildLineIndex(logPath)
    Fs.unlinkSync(logPath)
    Fs.writeFileSync(logPath, "delta\nepsilon\n", "utf8")
    const rebuilt = await extendLineIndex(initial)
    expect(rebuilt.completeLineCount).toBe(2)
    expect(rebuilt.ino).not.toBe(initial.ino)
    expect(await readLines(rebuilt, 0, 2)).toEqual(["delta", "epsilon"])
  })
})
