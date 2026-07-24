import * as Fs from "node:fs"
import * as Path from "node:path"

import type { EnvelopeIntegrityFileStat } from "@wireio/debugging-shared"
import {
  createEnvelopeBaseline,
  EnvelopeIntegrityIssueCode,
  readEnvelopeIntegrity
} from "@wireio/debugging-shared"

import {
  createNodeFileSystem,
  createStorageDir,
  removeStorageDir
} from "./envelopeIntegrityTestSupport.js"

describe("EnvelopeIntegrityReader verification close ordering", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it("retains post-scan verification then root-close diagnostics", async () => {
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([]),
      { fileSystem: verificationFaultFileSystem(2) }
    )

    expect(issueOperations(result)).toEqual([
      [EnvelopeIntegrityIssueCode.StorageRootChanged, null],
      [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "root_close"]
    ])
  })

  it("retains candidates, final verification, then root-close diagnostics", async () => {
    Fs.writeFileSync(Path.join(storageDir, "bad.data"), "bad")
    Fs.writeFileSync(Path.join(storageDir, "bad.metadata"), "bad")

    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([]),
      { fileSystem: verificationFaultFileSystem(3) }
    )

    expect(issueOperations(result)).toEqual([
      [EnvelopeIntegrityIssueCode.InvalidStorageKey, null],
      [EnvelopeIntegrityIssueCode.StorageRootChanged, null],
      [EnvelopeIntegrityIssueCode.StorageRootReadFailed, "root_close"]
    ])
  })
})

function verificationFaultFileSystem(failingStat: number) {
  return createNodeFileSystem({
    rootStat: async ({ stat, openCount, statCount }) =>
      openCount === 1 && statCount === failingStat
        ? changedIdentityStat(stat)
        : stat,
    rootClose: async ({ openCount, close }) => {
      await close()
      if (openCount === 1) throw fileError("root_close")
    }
  })
}

function changedIdentityStat(
  stat: EnvelopeIntegrityFileStat
): EnvelopeIntegrityFileStat {
  return { ...stat, ino: stat.ino + 1n }
}

function fileError(operation: string): Error {
  return Object.assign(new Error(operation), { code: "EIO" })
}

function issueOperations(
  result: Awaited<ReturnType<typeof readEnvelopeIntegrity>>
): readonly (readonly [EnvelopeIntegrityIssueCode, string | null])[] {
  return result.issues.map(issue => [
    issue.code,
    "error" in issue.context && issue.context.error !== null
      ? issue.context.error.operation
      : null
  ])
}
