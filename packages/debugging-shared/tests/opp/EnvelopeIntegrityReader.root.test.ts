import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  createEnvelopeBaseline,
  EnvelopeIntegrityIssueCode,
  readEnvelopeIntegrity
} from "@wireio/debugging-shared"

import {
  createNodeFileSystem,
  createStorageDir,
  removeStorageDir,
  writeEnvelopePair
} from "./envelopeIntegrityTestSupport.js"

describe("EnvelopeIntegrityReader root containment", () => {
  it("rejects a symlinked storage root", async () => {
    const container = createStorageDir(),
      target = Path.join(container, "target"),
      link = Path.join(container, "storage")
    try {
      Fs.mkdirSync(target)
      writeEnvelopePair(target)
      Fs.symlinkSync(target, link)

      const result = await readEnvelopeIntegrity(
        link,
        createEnvelopeBaseline([])
      )

      expect(result.valid).toEqual([])
      expect(result.issues[0]?.code).toBe(
        EnvelopeIntegrityIssueCode.StorageRootSymlink
      )
    } finally {
      removeStorageDir(container)
    }
  })

  it("rejects a symlinked storage-root ancestor", async () => {
    const container = createStorageDir(),
      targetParent = Path.join(container, "target-parent"),
      target = Path.join(targetParent, "storage"),
      linkParent = Path.join(container, "linked-parent")
    try {
      Fs.mkdirSync(targetParent)
      Fs.mkdirSync(target)
      writeEnvelopePair(target)
      Fs.symlinkSync(targetParent, linkParent)

      const result = await readEnvelopeIntegrity(
        Path.join(linkParent, "storage"),
        createEnvelopeBaseline([])
      )

      expect(result.valid).toEqual([])
      expect(result.issues[0]?.code).toBe(
        EnvelopeIntegrityIssueCode.StorageAncestorSymlink
      )
    } finally {
      removeStorageDir(container)
    }
  })

  it.each(["symlink", "directory"])(
    "rejects root replacement with a %s after scan",
    async replacement => {
      const container = createStorageDir(),
        storageDir = Path.join(container, "storage"),
        originalDir = Path.join(container, "original"),
        attackerDir = Path.join(container, "attacker"),
        scanReached = Promise.withResolvers<void>(),
        releaseScan = Promise.withResolvers<void>()
      try {
        Fs.mkdirSync(storageDir)
        Fs.mkdirSync(attackerDir)
        writeEnvelopePair(storageDir)
        writeEnvelopePair(attackerDir)
        const fileSystem = createNodeFileSystem({
            readdir: async (_path, read) => {
              const filenames = await read()
              scanReached.resolve()
              await releaseScan.promise
              return filenames
            }
          }),
          read = readEnvelopeIntegrity(storageDir, createEnvelopeBaseline([]), {
            fileSystem
          })
        await scanReached.promise
        Fs.renameSync(storageDir, originalDir)
        if (replacement === "symlink") {
          Fs.symlinkSync(attackerDir, storageDir)
        } else {
          Fs.mkdirSync(storageDir)
          writeEnvelopePair(storageDir)
        }
        releaseScan.resolve()

        const result = await read
        expect(result.valid).toEqual([])
        expect(result.issues[0]?.code).toBe(
          EnvelopeIntegrityIssueCode.StorageRootChanged
        )
      } finally {
        releaseScan.resolve()
        removeStorageDir(container)
      }
    }
  )

  it("fails closed when metadata is published during the anchored scan", async () => {
    const storageDir = createStorageDir(),
      pair = writeEnvelopePair(storageDir),
      scanReached = Promise.withResolvers<void>(),
      releaseScan = Promise.withResolvers<void>()
    Fs.rmSync(pair.metadataPath)
    try {
      const fileSystem = createNodeFileSystem({
          readdir: async (_path, read) => {
            const filenames = await read()
            scanReached.resolve()
            await releaseScan.promise
            return filenames
          }
        }),
        read = readEnvelopeIntegrity(storageDir, createEnvelopeBaseline([]), {
          fileSystem
        })
      await scanReached.promise
      Fs.writeFileSync(pair.metadataPath, pair.metadataBytes)
      releaseScan.resolve()

      const result = await read

      expect(result.valid).toEqual([])
      expect(result.pending).toEqual([])
      expect(result.issues[0]?.code).toBe(
        EnvelopeIntegrityIssueCode.StorageRootChanged
      )
    } finally {
      releaseScan.resolve()
      removeStorageDir(storageDir)
    }
  })
})
