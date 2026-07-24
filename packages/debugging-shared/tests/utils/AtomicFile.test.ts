import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import * as DebuggingShared from "@wireio/debugging-shared"

import {
  AtomicFilePublishers,
  atomicFileErrno,
  captureAtomicFileError,
  type AtomicFilePublishMode
} from "./atomicFileTestSupport.js"

const { AtomicFile } = DebuggingShared

function fileHandleFault(
  operation: "write" | "sync"
): Partial<DebuggingShared.AtomicFile.FileSystem> {
  return {
    open: async (file, flags, mode) => {
      const handle = await Fs.promises.open(file, flags, mode)
      if (flags !== "wx") return handle
      return {
        writeFile: data =>
          operation === "write"
            ? Promise.reject(atomicFileErrno("EIO"))
            : handle.writeFile(data),
        sync: () =>
          operation === "sync"
            ? Promise.reject(atomicFileErrno("EIO"))
            : handle.sync(),
        close: () => handle.close()
      }
    }
  }
}

function directorySyncFault(
  code: string
): Partial<DebuggingShared.AtomicFile.FileSystem> {
  return {
    open: async (file, flags, mode) => {
      const handle = await Fs.promises.open(file, flags, mode)
      if (flags !== "r") return handle
      return {
        writeFile: data => handle.writeFile(data),
        sync: () => Promise.reject(atomicFileErrno(code)),
        close: () => handle.close()
      }
    }
  }
}

describe("AtomicFile", () => {
  let tempPath: string

  beforeEach(() => {
    tempPath = Fs.mkdtempSync(Path.join(OS.tmpdir(), "atomic-file-"))
  })

  afterEach(() => {
    Fs.rmSync(tempPath, { recursive: true, force: true })
  })

  it("is exported from the package root", () => {
    expect(DebuggingShared).toHaveProperty("AtomicFile")
  })

  it("creates an immutable file and removes its same-directory temp", async () => {
    const finalFile = Path.join(tempPath, "created.txt")

    const result = await AtomicFile.create({
      finalFile,
      data: "complete-create"
    })

    expect(result).toEqual({ committed: true, finalFile })
    expect(Fs.readFileSync(finalFile, "utf8")).toBe("complete-create")
    expect(Fs.readdirSync(tempPath)).toEqual(["created.txt"])
  })

  it("replaces a checkpoint and leaves no temp", async () => {
    const finalFile = Path.join(tempPath, "checkpoint.txt")
    Fs.writeFileSync(finalFile, "old")

    const result = await AtomicFile.replace({
      finalFile,
      data: "complete-replace"
    })

    expect(result).toEqual({ committed: true, finalFile })
    expect(Fs.readFileSync(finalFile, "utf8")).toBe("complete-replace")
    expect(Fs.readdirSync(tempPath)).toEqual(["checkpoint.txt"])
  })

  it("rejects duplicate create without changing the existing file", async () => {
    const finalFile = Path.join(tempPath, "immutable.txt")
    Fs.writeFileSync(finalFile, "first")

    const error = await captureAtomicFileError(() =>
      AtomicFile.create({ finalFile, data: "second" })
    )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.Link,
      residualTempFile: null
    })
    expect(Fs.readFileSync(finalFile, "utf8")).toBe("first")
    expect(Fs.readdirSync(tempPath)).toEqual(["immutable.txt"])
  })

  it("allows exactly one winner in an independent create race", async () => {
    const finalFile = Path.join(tempPath, "race.txt"),
      bothAtLink = Promise.withResolvers<void>(),
      releaseLink = Promise.withResolvers<void>()
    let arrivals = 0
    const fileSystem: Partial<DebuggingShared.AtomicFile.FileSystem> = {
        link: async (tempFile, targetFile) => {
          arrivals += 1
          if (arrivals === 2) bothAtLink.resolve()
          await releaseLink.promise
          await Fs.promises.link(tempFile, targetFile)
        }
      },
      first = AtomicFile.create({ finalFile, data: "first" }, { fileSystem }),
      second = AtomicFile.create({ finalFile, data: "second" }, { fileSystem })

    await bothAtLink.promise
    releaseLink.resolve()
    const settled = await Promise.allSettled([first, second]),
      winners = settled.filter(result => result.status === "fulfilled"),
      losers = settled.filter(result => result.status === "rejected")

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({
      reason: expect.objectContaining({
        committed: false,
        stage: AtomicFile.Stage.Link
      })
    })
    expect(["first", "second"]).toContain(Fs.readFileSync(finalFile, "utf8"))
    expect(Fs.readdirSync(tempPath)).toEqual(["race.txt"])
  })

  it.each<AtomicFilePublishMode>(["create", "replace"])(
    "rejects a symlink final path in %s mode",
    async mode => {
      const targetFile = Path.join(tempPath, "target.txt"),
        finalFile = Path.join(tempPath, "link.txt")
      Fs.writeFileSync(targetFile, "target")
      Fs.symlinkSync(targetFile, finalFile)

      const error = await captureAtomicFileError(() =>
        AtomicFilePublishers[mode]({ finalFile, data: "replacement" })
      )

      expect(error).toMatchObject({
        committed: false,
        stage: AtomicFile.Stage.Validate,
        residualTempFile: null
      })
      expect(Fs.readFileSync(targetFile, "utf8")).toBe("target")
      expect(Fs.lstatSync(finalFile).isSymbolicLink()).toBe(true)
      expect(Fs.readdirSync(tempPath).sort()).toEqual([
        "link.txt",
        "target.txt"
      ])
    }
  )

  it.each([
    ["create", AtomicFile.Stage.TempWrite, fileHandleFault("write")],
    ["replace", AtomicFile.Stage.FileSync, fileHandleFault("sync")],
    [
      "create",
      AtomicFile.Stage.Link,
      { link: () => Promise.reject(atomicFileErrno("EIO")) }
    ],
    [
      "replace",
      AtomicFile.Stage.Rename,
      { rename: () => Promise.reject(atomicFileErrno("EIO")) }
    ]
  ] satisfies readonly [
    AtomicFilePublishMode,
    DebuggingShared.AtomicFile.Stage,
    Partial<DebuggingShared.AtomicFile.FileSystem>
  ][])(
    "keeps final authoritative on pre-commit %s failure at %s",
    async (mode, stage, fileSystem) => {
      const finalFile = Path.join(tempPath, "precommit.txt")
      if (mode === "replace") Fs.writeFileSync(finalFile, "old")

      const error = await captureAtomicFileError(() =>
        AtomicFilePublishers[mode]({ finalFile, data: "new" }, { fileSystem })
      )

      expect(error).toMatchObject({
        committed: false,
        stage,
        residualTempFile: null
      })
      expect(
        Fs.existsSync(finalFile) ? Fs.readFileSync(finalFile, "utf8") : null
      ).toBe(mode === "replace" ? "old" : null)
      expect(Fs.readdirSync(tempPath)).toEqual(
        mode === "replace" ? ["precommit.txt"] : []
      )
    }
  )

  it("reports a complete committed final and residual temp when unlink fails", async () => {
    const finalFile = Path.join(tempPath, "unlink.txt"),
      error = await captureAtomicFileError(() =>
        AtomicFile.create(
          { finalFile, data: "complete" },
          {
            fileSystem: {
              unlink: () => Promise.reject(atomicFileErrno("EIO"))
            }
          }
        )
      )

    expect(error).toMatchObject({
      committed: true,
      stage: AtomicFile.Stage.TempUnlink
    })
    expect(error.residualTempFile).not.toBeNull()
    expect(Fs.readFileSync(finalFile, "utf8")).toBe("complete")
    expect(Fs.readFileSync(error.residualTempFile ?? "", "utf8")).toBe(
      "complete"
    )
    expect(Fs.readdirSync(tempPath)).toHaveLength(2)
  })

  it.each<AtomicFilePublishMode>(["create", "replace"])(
    "reports committed complete final on %s directory-sync failure",
    async mode => {
      const finalFile = Path.join(tempPath, "directory-sync.txt")
      if (mode === "replace") Fs.writeFileSync(finalFile, "old")

      const error = await captureAtomicFileError(() =>
        AtomicFilePublishers[mode](
          { finalFile, data: "complete" },
          { fileSystem: directorySyncFault("EIO") }
        )
      )

      expect(error).toMatchObject({
        committed: true,
        stage: AtomicFile.Stage.DirectorySync,
        residualTempFile: null
      })
      expect(Fs.readFileSync(finalFile, "utf8")).toBe("complete")
      expect(Fs.readdirSync(tempPath)).toEqual(["directory-sync.txt"])
    }
  )

  it.each(["EINVAL", "ENOTSUP", "ENOSYS"])(
    "ignores enumerated unsupported directory-sync error %s",
    async code => {
      const finalFile = Path.join(tempPath, `${code}.txt`)

      await expect(
        AtomicFile.create(
          { finalFile, data: code },
          { fileSystem: directorySyncFault(code) }
        )
      ).resolves.toEqual({ committed: true, finalFile })
      expect(Fs.readFileSync(finalFile, "utf8")).toBe(code)
      expect(Fs.readdirSync(tempPath)).toEqual([`${code}.txt`])
    }
  )
})
