import * as Fs from "node:fs"

import type { EnvelopeIntegrityFileSystem } from "@wireio/debugging-shared"
import {
  captureEnvelopeBaseline,
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

describe("EnvelopeIntegrityReader anchored root faults", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
    writeEnvelopePair(storageDir)
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it("normalizes descriptor-anchored readdir and closes the root", async () => {
    const base = createNodeFileSystem()
    let closeCount = 0
    const fileSystem: EnvelopeIntegrityFileSystem = {
        ...base,
        openDirectory: async path => {
          const root = await base.openDirectory(path)
          return {
            ...root,
            readdir: async () => {
              throw Object.assign(new Error("readdir"), { code: "EIO" })
            },
            close: async () => {
              closeCount += 1
              await root.close()
            }
          }
        }
      },
      result = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([]),
        { fileSystem }
      )

    expect(closeCount).toBe(1)
    expect(result.valid).toEqual([])
    expect(result.issues[0]).toMatchObject({
      code: EnvelopeIntegrityIssueCode.DirectoryScanFailed,
      context: { error: { operation: "readdir" } }
    })
  })

  it("normalizes descriptor-anchored initial child open", async () => {
    const base = createNodeFileSystem(),
      fileSystem: EnvelopeIntegrityFileSystem = {
        ...base,
        openDirectory: async path => {
          const root = await base.openDirectory(path)
          return {
            ...root,
            openChild: async () => {
              throw Object.assign(new Error("open"), { code: "EIO" })
            }
          }
        }
      },
      result = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([]),
        { fileSystem }
      )

    expect(result.valid).toEqual([])
    expect(result.issues[0]).toMatchObject({
      code: EnvelopeIntegrityIssueCode.DataReadFailed,
      context: { error: { operation: "open" } }
    })
  })

  it("normalizes retained root close failure", async () => {
    const base = createNodeFileSystem(),
      fileSystem: EnvelopeIntegrityFileSystem = {
        ...base,
        openDirectory: async path => {
          const root = await base.openDirectory(path)
          return {
            ...root,
            close: async () => {
              await root.close()
              throw Object.assign(new Error("root_close"), { code: "EIO" })
            }
          }
        }
      },
      result = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([]),
        { fileSystem }
      )

    expect(result.valid).toEqual([])
    expect(result.issues[0]).toMatchObject({
      code: EnvelopeIntegrityIssueCode.StorageRootReadFailed,
      context: { error: { operation: "root_close" } }
    })
  })

  it("retains candidate issues when the final root close fails", async () => {
    // Given: candidate validation finds an invalid key and the retained root fails to close.
    let rootOpenCount = 0
    const pair = writeEnvelopePair(storageDir),
      base = createNodeFileSystem(),
      fileSystem: EnvelopeIntegrityFileSystem = {
        ...base,
        openDirectory: async path => {
          const root = await base.openDirectory(path),
            openCount = ++rootOpenCount
          return {
            ...root,
            close: async () => {
              await root.close()
              if (openCount === 1)
                throw Object.assign(new Error("root_close"), { code: "EIO" })
            }
          }
        }
      }
    Fs.writeFileSync(`${storageDir}/bad.data`, Buffer.alloc(0))
    Fs.writeFileSync(`${storageDir}/bad.metadata`, Buffer.alloc(0))

    // When: the strict reader completes validation and closes the retained root.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([pair.baseKey]),
      { fileSystem }
    )

    // Then: the terminal root failure retains the deterministic candidate issue first.
    expect(result).toMatchObject({
      kind: "scan_failed",
      valid: [],
      pending: []
    })
    expect(result.issues.map(issue => [issue.code, issue.baseKey])).toEqual([
      [EnvelopeIntegrityIssueCode.InvalidStorageKey, "bad"],
      [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "$storage"]
    ])
  })

  it.each([2, 3])(
    "normalizes descriptor snapshot readdir %s failure and closes the root",
    async failingRead => {
      let readdirCount = 0,
        closeCount = 0
      const base = createNodeFileSystem({
          readdir: async (_path, read) => {
            readdirCount += 1
            if (readdirCount === failingRead) {
              throw Object.assign(new Error("readdir"), { code: "EIO" })
            }
            return read()
          }
        }),
        fileSystem: EnvelopeIntegrityFileSystem = {
          ...base,
          openDirectory: async path => {
            const root = await base.openDirectory(path)
            return {
              ...root,
              close: async () => {
                closeCount += 1
                await root.close()
              }
            }
          }
        },
        result = await readEnvelopeIntegrity(
          storageDir,
          createEnvelopeBaseline([]),
          { fileSystem }
        )

      expect(closeCount).toBeGreaterThan(0)
      expect(result.valid).toEqual([])
      expect(result.pending).toEqual([])
      expect(result.issues[0]).toMatchObject({
        code: EnvelopeIntegrityIssueCode.DirectoryScanFailed,
        context: { error: { operation: "readdir" } }
      })
    }
  )

  it("normalizes baseline snapshot readdir failure and closes the root", async () => {
    let readdirCount = 0,
      closeCount = 0
    const base = createNodeFileSystem({
        readdir: async (_path, read) => {
          readdirCount += 1
          if (readdirCount === 2) {
            throw Object.assign(new Error("readdir"), { code: "EIO" })
          }
          return read()
        }
      }),
      fileSystem: EnvelopeIntegrityFileSystem = {
        ...base,
        openDirectory: async path => {
          const root = await base.openDirectory(path)
          return {
            ...root,
            close: async () => {
              closeCount += 1
              await root.close()
            }
          }
        }
      },
      result = await captureEnvelopeBaseline(storageDir, { fileSystem })

    expect(closeCount).toBeGreaterThan(0)
    expect(result).toMatchObject({
      kind: "failed",
      issues: [
        {
          code: EnvelopeIntegrityIssueCode.BaselineCaptureFailed,
          context: { error: { operation: "readdir" } }
        }
      ]
    })
  })
})
