import * as Fs from "node:fs"

import type { EnvelopeIntegrityFileSystem } from "@wireio/debugging-shared"
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

describe("EnvelopeIntegrityReader final snapshot faults", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it("retains candidate issues when the final snapshot readdir fails", async () => {
    // Given: candidate validation finds an invalid key before the final snapshot fails.
    let readdirCount = 0
    const pair = writeEnvelopePair(storageDir),
      fileSystem = createNodeFileSystem({
        readdir: async (_path, read) => {
          readdirCount += 1
          if (readdirCount === 3)
            throw Object.assign(new Error("readdir"), { code: "EIO" })
          return read()
        }
      })
    writeInvalidCandidate(storageDir)

    // When: collection reaches final snapshot revalidation.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([pair.baseKey]),
      { fileSystem }
    )

    // Then: candidate and snapshot failures remain ordered and terminal records are empty.
    expectTerminalIssues(result, [
      [EnvelopeIntegrityIssueCode.InvalidStorageKey, "bad"],
      [EnvelopeIntegrityIssueCode.DirectoryScanFailed, "$storage"]
    ])
  })

  it("retains candidate issues when the final snapshot changes", async () => {
    // Given: candidate validation finds an invalid key before the final snapshot changes.
    let readdirCount = 0
    const pair = writeEnvelopePair(storageDir),
      fileSystem = createNodeFileSystem({
        readdir: async (_path, read) => {
          readdirCount += 1
          const filenames = await read()
          return readdirCount === 3 ? [...filenames, "changed"] : filenames
        }
      })
    writeInvalidCandidate(storageDir)

    // When: collection reaches final snapshot revalidation.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([pair.baseKey]),
      { fileSystem }
    )

    // Then: candidate and snapshot failures remain ordered and terminal records are empty.
    expectTerminalIssues(result, [
      [EnvelopeIntegrityIssueCode.InvalidStorageKey, "bad"],
      [EnvelopeIntegrityIssueCode.StorageRootChanged, "$storage"]
    ])
  })

  it("retains candidate and final snapshot issues when root close also fails", async () => {
    // Given: candidate validation and final snapshot fail, then the retained root fails to close.
    let readdirCount = 0,
      rootOpenCount = 0
    const pair = writeEnvelopePair(storageDir),
      base = createNodeFileSystem({
        readdir: async (_path, read) => {
          readdirCount += 1
          if (readdirCount === 3)
            throw Object.assign(new Error("readdir"), { code: "EIO" })
          return read()
        }
      }),
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
    writeInvalidCandidate(storageDir)

    // When: collection reaches final snapshot revalidation and closes the retained root.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([pair.baseKey]),
      { fileSystem }
    )

    // Then: every simultaneous terminal issue follows the deterministic candidate issue.
    expectTerminalIssues(result, [
      [EnvelopeIntegrityIssueCode.InvalidStorageKey, "bad"],
      [EnvelopeIntegrityIssueCode.DirectoryScanFailed, "$storage"],
      [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "$storage"]
    ])
  })
})

function writeInvalidCandidate(storageDir: string): void {
  Fs.writeFileSync(`${storageDir}/bad.data`, Buffer.alloc(0))
  Fs.writeFileSync(`${storageDir}/bad.metadata`, Buffer.alloc(0))
}

function expectTerminalIssues(
  result: Awaited<ReturnType<typeof readEnvelopeIntegrity>>,
  expected: readonly (readonly [EnvelopeIntegrityIssueCode, string])[]
): void {
  expect(result).toMatchObject({ kind: "scan_failed", valid: [], pending: [] })
  expect(result.issues.map(issue => [issue.code, issue.baseKey])).toEqual(expected)
}
