import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { AtomicFile } from "@wireio/debugging-shared"

import {
  AtomicFilePublishers,
  atomicFileErrno,
  captureAtomicFileError,
  type AtomicFilePublishMode
} from "./atomicFileTestSupport.js"

function wrappedHandle(
  handle: AtomicFile.FileHandle,
  failures: Readonly<{
    readonly write?: NodeJS.ErrnoException
    readonly sync?: NodeJS.ErrnoException
    readonly close?: NodeJS.ErrnoException
  }>
): AtomicFile.FileHandle {
  return {
    writeFile: data =>
      failures.write ? Promise.reject(failures.write) : handle.writeFile(data),
    sync: () => (failures.sync ? Promise.reject(failures.sync) : handle.sync()),
    close: async () => {
      await handle.close()
      if (failures.close) throw failures.close
    }
  }
}

describe("AtomicFile correction acceptance", () => {
  let tempPath: string

  beforeEach(() => {
    tempPath = Fs.mkdtempSync(Path.join(OS.tmpdir(), "atomic-correction-"))
  })

  afterEach(() => {
    Fs.rmSync(tempPath, { recursive: true, force: true })
  })

  it.each<AtomicFilePublishMode>(["create", "replace"])(
    "rejects a symlinked parent in %s mode without redirecting publication",
    async mode => {
      const realParent = Path.join(tempPath, "real"),
        linkedParent = Path.join(tempPath, "linked"),
        finalFile = Path.join(linkedParent, "final.txt")
      Fs.mkdirSync(realParent)
      Fs.symlinkSync(realParent, linkedParent, "dir")
      if (mode === "replace")
        Fs.writeFileSync(Path.join(realParent, "final.txt"), "old")

      const error = await captureAtomicFileError(() =>
        AtomicFilePublishers[mode]({ finalFile, data: "redirected" })
      )

      expect(error).toMatchObject({
        committed: false,
        stage: AtomicFile.Stage.Validate
      })
      expect(
        Fs.existsSync(Path.join(realParent, "final.txt"))
          ? Fs.readFileSync(Path.join(realParent, "final.txt"), "utf8")
          : null
      ).toBe(mode === "replace" ? "old" : null)
      expect(Fs.readdirSync(realParent)).toEqual(
        mode === "replace" ? ["final.txt"] : []
      )
    }
  )

  it("reports TempOpen and leaves no final or temp", async () => {
    const finalFile = Path.join(tempPath, "open.txt"),
      error = await captureAtomicFileError(() =>
        AtomicFile.create(
          { finalFile, data: "data" },
          {
            fileSystem: { open: () => Promise.reject(atomicFileErrno("EOPEN")) }
          }
        )
      )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.TempOpen
    })
    expect(Fs.readdirSync(tempPath)).toEqual([])
  })

  it("reports TempClose after a successful file sync and removes the temp", async () => {
    const finalFile = Path.join(tempPath, "close.txt"),
      fileSystem: Partial<AtomicFile.FileSystem> = {
        open: async (file, flags, mode) =>
          wrappedHandle(await Fs.promises.open(file, flags, mode), {
            close: flags === "wx" ? atomicFileErrno("ECLOSE") : undefined
          })
      },
      error = await captureAtomicFileError(() =>
        AtomicFile.create({ finalFile, data: "data" }, { fileSystem })
      )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.TempClose
    })
    expect(Fs.readdirSync(tempPath)).toEqual([])
  })

  it("reports non-ENOENT lstat validation failures", async () => {
    const finalFile = Path.join(tempPath, "validate.txt"),
      error = await captureAtomicFileError(() =>
        AtomicFile.create(
          { finalFile, data: "data" },
          {
            fileSystem: {
              lstat: () => Promise.reject(atomicFileErrno("EACCES"))
            }
          }
        )
      )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.Validate
    })
    expect(Fs.readdirSync(tempPath)).toEqual([])
  })

  it("reports an existing residual when pre-commit cleanup fails", async () => {
    const finalFile = Path.join(tempPath, "cleanup.txt"),
      error = await captureAtomicFileError(() =>
        AtomicFile.create(
          { finalFile, data: "complete" },
          {
            fileSystem: {
              link: () => Promise.reject(atomicFileErrno("ELINK")),
              unlink: () => Promise.reject(atomicFileErrno("ECLEANUP"))
            }
          }
        )
      )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.Link
    })
    expect(error.residualTempFile).not.toBeNull()
    expect(Fs.readFileSync(error.residualTempFile ?? "", "utf8")).toBe(
      "complete"
    )
  })

  it.each(["EIO", "EINVAL", "ENOTSUP", "ENOSYS"])(
    "reports DirectoryOpen for %s instead of applying the sync allowlist",
    async code => {
      const finalFile = Path.join(tempPath, `${code}.txt`),
        error = await captureAtomicFileError(() =>
          AtomicFile.create(
            { finalFile, data: "complete" },
            {
              fileSystem: {
                open: (file, flags, mode) =>
                  flags === "r"
                    ? Promise.reject(atomicFileErrno(code))
                    : Fs.promises.open(file, flags, mode)
              }
            }
          )
        )

      expect(error).toMatchObject({
        committed: true,
        stage: AtomicFile.Stage.DirectoryOpen
      })
      expect(Fs.readFileSync(finalFile, "utf8")).toBe("complete")
    }
  )

  it("reports DirectoryClose after successful directory sync", async () => {
    const finalFile = Path.join(tempPath, "directory-close.txt"),
      fileSystem: Partial<AtomicFile.FileSystem> = {
        open: async (file, flags, mode) =>
          wrappedHandle(await Fs.promises.open(file, flags, mode), {
            close: flags === "r" ? atomicFileErrno("EDIRCLOSE") : undefined
          })
      },
      error = await captureAtomicFileError(() =>
        AtomicFile.create({ finalFile, data: "complete" }, { fileSystem })
      )

    expect(error).toMatchObject({
      committed: true,
      stage: AtomicFile.Stage.DirectoryClose
    })
    expect(Fs.readFileSync(finalFile, "utf8")).toBe("complete")
  })

  it.each([
    ["write", AtomicFile.Stage.TempWrite],
    ["sync", AtomicFile.Stage.FileSync]
  ] as const)(
    "preserves the primary file %s fault when close also fails",
    async (operation, stage) => {
      const primary = atomicFileErrno(
          operation === "write" ? "EWRITE" : "EFILESYNC"
        ),
        secondary = atomicFileErrno("ECLOSE"),
        finalFile = Path.join(tempPath, `${operation}.txt`),
        fileSystem: Partial<AtomicFile.FileSystem> = {
          open: async (file, flags, mode) =>
            wrappedHandle(await Fs.promises.open(file, flags, mode), {
              [operation]: primary,
              close: secondary
            })
        },
        error = await captureAtomicFileError(() =>
          AtomicFile.create({ finalFile, data: "data" }, { fileSystem })
        )

      expect(error).toMatchObject({ committed: false, stage })
      expect(error.cause).toMatchObject({ code: primary.code })
      expect(error).toHaveProperty("secondaryFailures", [
        { stage: AtomicFile.Stage.TempClose, cause: secondary }
      ])
    }
  )

  it("preserves directory-sync as primary when directory close also fails", async () => {
    const primary = atomicFileErrno("EDIRSYNC"),
      secondary = atomicFileErrno("EDIRCLOSE"),
      finalFile = Path.join(tempPath, "directory-both.txt"),
      fileSystem: Partial<AtomicFile.FileSystem> = {
        open: async (file, flags, mode) =>
          wrappedHandle(
            await Fs.promises.open(file, flags, mode),
            flags === "r" ? { sync: primary, close: secondary } : {}
          )
      },
      error = await captureAtomicFileError(() =>
        AtomicFile.create({ finalFile, data: "complete" }, { fileSystem })
      )

    expect(error).toMatchObject({
      committed: true,
      stage: AtomicFile.Stage.DirectorySync
    })
    expect(error.cause).toMatchObject({ code: primary.code })
    expect(error).toHaveProperty("secondaryFailures", [
      { stage: AtomicFile.Stage.DirectoryClose, cause: secondary }
    ])
  })

  it("publishes Uint8Array bytes with a custom mode", async () => {
    const finalFile = Path.join(tempPath, "bytes.bin"),
      data = Uint8Array.from([0, 1, 127, 255])

    await AtomicFile.create({ finalFile, data, mode: 0o640 })

    expect(Fs.readFileSync(finalFile)).toEqual(Buffer.from(data))
    expect(Fs.statSync(finalFile).mode & 0o777).toBe(0o640)
  })

  it("treats post-link ENOENT as successful temp absence", async () => {
    const finalFile = Path.join(tempPath, "enoent.txt"),
      fileSystem: Partial<AtomicFile.FileSystem> = {
        unlink: async file => {
          await Fs.promises.unlink(file)
          throw atomicFileErrno("ENOENT")
        }
      }

    await expect(
      AtomicFile.create({ finalFile, data: "complete" }, { fileSystem })
    ).resolves.toEqual({ committed: true, finalFile })
    expect(Fs.readdirSync(tempPath)).toEqual(["enoent.txt"])
  })
})
