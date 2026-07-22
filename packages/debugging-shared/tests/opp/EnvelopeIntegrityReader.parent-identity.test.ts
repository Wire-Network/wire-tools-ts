import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  captureEnvelopeBaseline,
  createEnvelopeBaseline,
  EnvelopeIntegrityIssueCode,
  readEnvelopeIntegrity
} from "@wireio/debugging-shared"

import {
  createNodeFileSystem,
  createStorageDir,
  removeStorageDir
} from "./envelopeIntegrityTestSupport.js"

describe("EnvelopeIntegrityReader ancestor identity", () => {
  it("captures a baseline through unrelated parent-sibling activity", async () => {
    const fixture = createNestedStorage()
    try {
      const result = await captureEnvelopeBaseline(fixture.storageDir, {
        fileSystem: siblingActivityFileSystem(fixture)
      })

      expect(result).toMatchObject({ kind: "captured" })
    } finally {
      removeStorageDir(fixture.container)
    }
  })

  it("collects through unrelated parent-sibling activity", async () => {
    const fixture = createNestedStorage()
    try {
      const result = await readEnvelopeIntegrity(
        fixture.storageDir,
        createEnvelopeBaseline([]),
        { fileSystem: siblingActivityFileSystem(fixture) }
      )

      expect(result).toMatchObject({ kind: "collected", issues: [] })
    } finally {
      removeStorageDir(fixture.container)
    }
  })

  it.each(["root", "ancestor"] as const)(
    "detects %s replacement after the initial scan",
    async replacement => {
      const fixture = createNestedStorage(),
        moved = Path.join(fixture.container, `moved-${replacement}`),
        scanReached = Promise.withResolvers<void>(),
        releaseScan = Promise.withResolvers<void>()
      try {
        const fileSystem = createNodeFileSystem({
            readdir: async (_path, read) => {
              const filenames = await read()
              scanReached.resolve()
              await releaseScan.promise
              return filenames
            }
          }),
          read = readEnvelopeIntegrity(
            fixture.storageDir,
            createEnvelopeBaseline([]),
            { fileSystem }
          )
        await scanReached.promise
        if (replacement === "root") {
          Fs.renameSync(fixture.storageDir, moved)
          Fs.mkdirSync(fixture.storageDir)
        } else {
          Fs.renameSync(fixture.parent, moved)
          Fs.mkdirSync(fixture.parent)
          Fs.mkdirSync(fixture.storageDir)
        }
        releaseScan.resolve()

        const result = await read
        expect(result.issues.map(issue => issue.code)).toContain(
          EnvelopeIntegrityIssueCode.StorageRootChanged
        )
      } finally {
        releaseScan.resolve()
        removeStorageDir(fixture.container)
      }
    }
  )
})

type NestedStorageFixture = {
  readonly container: string
  readonly parent: string
  readonly storageDir: string
}

function createNestedStorage(): NestedStorageFixture {
  const container = createStorageDir(),
    parent = Path.join(container, "parent"),
    storageDir = Path.join(parent, "storage")
  Fs.mkdirSync(storageDir, { recursive: true })
  return { container, parent, storageDir }
}

function siblingActivityFileSystem(fixture: NestedStorageFixture) {
  const base = createNodeFileSystem()
  let parentStatCount = 0
  return {
    ...base,
    lstat: async (path: string) => {
      if (path === fixture.parent) {
        parentStatCount += 1
        if (parentStatCount === 2) {
          const sibling = Path.join(fixture.parent, "unrelated-sibling")
          Fs.writeFileSync(sibling, "unrelated")
          Fs.rmSync(sibling)
        }
      }
      return base.lstat(path)
    }
  }
}
