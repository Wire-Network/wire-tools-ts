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

describe("EnvelopeIntegrityReader descriptor safety", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it.each([
    ["data", "data_sidecar_symlink"],
    ["metadata", "metadata_sidecar_symlink"]
  ])("rejects a pre-existing %s symlink", async (sidecar, expectedCode) => {
    const pair = writeEnvelopePair(storageDir),
      path = sidecar === "data" ? pair.dataPath : pair.metadataPath,
      target = Path.join(storageDir, `${sidecar}-target`)
    Fs.writeFileSync(target, "target")
    Fs.rmSync(path)
    Fs.symlinkSync(target, path)

    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    expect(result.issues[0]?.code).toBe(expectedCode)
  })

  it.each([
    ["data", "data_sidecar_not_regular"],
    ["metadata", "metadata_sidecar_not_regular"]
  ])("rejects a non-regular %s sidecar", async (sidecar, expectedCode) => {
    const pair = writeEnvelopePair(storageDir),
      path = sidecar === "data" ? pair.dataPath : pair.metadataPath
    Fs.rmSync(path)
    Fs.mkdirSync(path)

    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    expect(result.issues[0]?.code).toBe(expectedCode)
  })

  it.each([
    ["data", "data_read_failed"],
    ["metadata", "metadata_read_failed"]
  ])("normalizes a %s open failure", async (sidecar, expectedCode) => {
    const pair = writeEnvelopePair(storageDir),
      path = sidecar === "data" ? pair.dataPath : pair.metadataPath,
      fileSystem = createNodeFileSystem({
        beforeOpen: async file => {
          if (file === path) {
            throw Object.assign(new Error("open failed"), { code: "EIO" })
          }
        }
      })

    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([]),
      { fileSystem }
    )

    expect(result.issues[0]).toMatchObject({
      code: expectedCode,
      context: { error: { code: "EIO", operation: "open" } }
    })
  })

  it.each([
    ["data", "data_sidecar_changed"],
    ["metadata", "metadata_sidecar_changed"]
  ])(
    "rejects %s mutation after descriptor read",
    async (sidecar, expectedCode) => {
      const pair = writeEnvelopePair(storageDir),
        path = sidecar === "data" ? pair.dataPath : pair.metadataPath,
        readReached = Promise.withResolvers<void>(),
        releaseRead = Promise.withResolvers<void>(),
        fileSystem = createNodeFileSystem({
          afterRead: async file => {
            if (file !== path) return
            readReached.resolve()
            await releaseRead.promise
          }
        }),
        read = readEnvelopeIntegrity(storageDir, createEnvelopeBaseline([]), {
          fileSystem
        })
      await readReached.promise
      Fs.appendFileSync(path, Buffer.from([0]))
      releaseRead.resolve()

      const result = await read
      expect(result.issues[0]?.code).toBe(expectedCode)
    }
  )

  it.each([
    ["data", EnvelopeIntegrityIssueCode.DataSidecarChanged],
    ["metadata", EnvelopeIntegrityIssueCode.MetadataSidecarChanged]
  ])(
    "rejects %s pathname replacement after read",
    async (sidecar, expectedCode) => {
      const pair = writeEnvelopePair(storageDir),
        path = sidecar === "data" ? pair.dataPath : pair.metadataPath,
        readReached = Promise.withResolvers<void>(),
        releaseRead = Promise.withResolvers<void>(),
        fileSystem = createNodeFileSystem({
          afterRead: async file => {
            if (file !== path) return
            readReached.resolve()
            await releaseRead.promise
          }
        }),
        read = readEnvelopeIntegrity(storageDir, createEnvelopeBaseline([]), {
          fileSystem
        })
      await readReached.promise
      Fs.renameSync(path, `${path}.old`)
      Fs.writeFileSync(path, "replacement")
      releaseRead.resolve()

      const result = await read
      expect(result.issues[0]?.code).toBe(expectedCode)
    }
  )

  it.each([
    ["unlink", EnvelopeIntegrityIssueCode.DataSidecarChanged],
    ["truncate", "data_sidecar_changed"],
    ["symlink", "data_sidecar_changed"]
  ])("rejects barrier-controlled data %s", async (mutation, expectedCode) => {
    const pair = writeEnvelopePair(storageDir),
      readReached = Promise.withResolvers<void>(),
      releaseRead = Promise.withResolvers<void>(),
      fileSystem = createNodeFileSystem({
        afterRead: async file => {
          if (file !== pair.dataPath) return
          readReached.resolve()
          await releaseRead.promise
        }
      }),
      read = readEnvelopeIntegrity(storageDir, createEnvelopeBaseline([]), {
        fileSystem
      })
    await readReached.promise
    if (mutation === "unlink") Fs.rmSync(pair.dataPath)
    if (mutation === "truncate") Fs.truncateSync(pair.dataPath, 1)
    if (mutation === "symlink") {
      Fs.rmSync(pair.dataPath)
      Fs.symlinkSync(pair.metadataPath, pair.dataPath)
    }
    releaseRead.resolve()

    const result = await read
    expect(result.issues[0]?.code).toBe(expectedCode)
  })

  it("uses at most 16 workers and reaches 16 deferred reads", async () => {
    Array.from({ length: 20 }, (_, index) => index).forEach(index => {
      writeEnvelopePair(storageDir, { epochEnvelopeIndex: index })
    })
    const sixteenStarted = Promise.withResolvers<void>(),
      releaseReads = Promise.withResolvers<void>()
    let active = 0,
      maximum = 0,
      released = false
    const fileSystem = createNodeFileSystem({
        afterRead: async file => {
          if (!file.endsWith(".data") || released) return
          active += 1
          maximum = Math.max(maximum, active)
          if (active === 16) sixteenStarted.resolve()
          await releaseReads.promise
          active -= 1
        }
      }),
      read = readEnvelopeIntegrity(storageDir, createEnvelopeBaseline([]), {
        fileSystem
      })
    await sixteenStarted.promise
    released = true
    releaseReads.resolve()

    const result = await read
    expect(result.valid).toHaveLength(20)
    expect(maximum).toBe(16)
  })
})
