import type { EnvelopeIntegrityFileStat } from "@wireio/debugging-shared"
import {
  captureEnvelopeBaseline,
  EnvelopeIntegrityIssueCode
} from "@wireio/debugging-shared"

import {
  createNodeFileSystem,
  createStorageDir,
  removeStorageDir
} from "./envelopeIntegrityTestSupport.js"

describe("EnvelopeIntegrityReader baseline close ordering", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it.each([1, 2])(
    "retains baseline readdir %s then root-close diagnostics",
    async failingRead => {
      let readdirCount = 0
      const base = createNodeFileSystem({
          readdir: async (_path, read) => {
            readdirCount += 1
            if (readdirCount === failingRead) throw fileError("readdir")
            return read()
          }
        }),
        result = await captureEnvelopeBaseline(storageDir, {
          fileSystem: failRetainedClose(base)
        })

      expect(failedIssueOperations(result)).toEqual([
        [EnvelopeIntegrityIssueCode.BaselineCaptureFailed, "readdir"],
        [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "root_close"]
      ])
    }
  )

  it("retains pin non-directory then root-close diagnostics", async () => {
    const result = await captureEnvelopeBaseline(storageDir, {
      fileSystem: createNodeFileSystem({
        rootStat: async ({ stat, openCount }) =>
          openCount === 1 ? nonDirectoryStat(stat) : stat,
        rootClose: failFirstClose
      })
    })

    expect(failedIssueOperations(result)).toEqual([
      [EnvelopeIntegrityIssueCode.StorageRootNotDirectory, null],
      [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "root_close"]
    ])
  })

  it("retains pin identity mismatch then root-close diagnostics", async () => {
    const result = await captureEnvelopeBaseline(storageDir, {
      fileSystem: createNodeFileSystem({
        rootStat: async ({ stat, openCount }) =>
          openCount === 1 ? changedIdentityStat(stat) : stat,
        rootClose: failFirstClose
      })
    })

    expect(failedIssueOperations(result)).toEqual([
      [EnvelopeIntegrityIssueCode.StorageRootChanged, null],
      [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "root_close"]
    ])
  })

  it("retains pin stat throw then root-close diagnostics", async () => {
    const result = await captureEnvelopeBaseline(storageDir, {
      fileSystem: createNodeFileSystem({
        rootStat: async ({ stat, openCount }) => {
          if (openCount === 1) throw fileError("root_stat")
          return stat
        },
        rootClose: failFirstClose
      })
    })

    expect(failedIssueOperations(result)).toEqual([
      [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "root_stat"],
      [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "root_close"]
    ])
  })
})

function failRetainedClose(
  base: ReturnType<typeof createNodeFileSystem>
): ReturnType<typeof createNodeFileSystem> {
  let openCount = 0
  return {
    ...base,
    openDirectory: async path => {
      const root = await base.openDirectory(path),
        currentOpen = ++openCount
      return {
        ...root,
        close: async () => {
          await root.close()
          if (currentOpen === 1) throw fileError("root_close")
        }
      }
    }
  }
}

async function failFirstClose({
  openCount,
  close
}: {
  readonly openCount: number
  readonly close: () => Promise<void>
}): Promise<void> {
  await close()
  if (openCount === 1) throw fileError("root_close")
}

function changedIdentityStat(
  stat: EnvelopeIntegrityFileStat
): EnvelopeIntegrityFileStat {
  return {
    dev: stat.dev,
    ino: stat.ino + 1n,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => stat.isSymbolicLink()
  }
}

function nonDirectoryStat(
  stat: EnvelopeIntegrityFileStat
): EnvelopeIntegrityFileStat {
  return { ...stat, isDirectory: () => false }
}

function fileError(operation: string): Error {
  return Object.assign(new Error(operation), { code: "EIO" })
}

function failedIssueOperations(
  result: Awaited<ReturnType<typeof captureEnvelopeBaseline>>
): readonly (readonly [EnvelopeIntegrityIssueCode, string | null])[] {
  if (result.kind === "captured") return []
  return result.issues.map(issue => [
    issue.code,
    "error" in issue.context && issue.context.error !== null
      ? issue.context.error.operation
      : null
  ])
}
