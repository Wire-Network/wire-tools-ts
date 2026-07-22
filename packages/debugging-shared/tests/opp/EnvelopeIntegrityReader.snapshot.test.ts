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
  writeEnvelopePair,
  type EnvelopePairFixture
} from "./envelopeIntegrityTestSupport.js"

type SnapshotMutation = (pair: EnvelopePairFixture) => void

const SnapshotMutations: readonly [string, SnapshotMutation][] = [
  ["data removal", pair => Fs.rmSync(pair.dataPath)],
  ["metadata removal", pair => Fs.rmSync(pair.metadataPath)],
  [
    "data rename",
    pair => Fs.renameSync(pair.dataPath, `${pair.dataPath}.renamed`)
  ],
  [
    "metadata rename",
    pair => Fs.renameSync(pair.metadataPath, `${pair.metadataPath}.renamed`)
  ]
]

describe("EnvelopeIntegrityReader anchored filename snapshots", () => {
  it("rejects metadata publication even when root stat fields stay frozen", async () => {
    const storageDir = createStorageDir(),
      pair = writeEnvelopePair(storageDir)
    Fs.rmSync(pair.metadataPath)
    try {
      const seam = frozenSnapshotFileSystem(storageDir, () =>
          Fs.writeFileSync(pair.metadataPath, pair.metadataBytes)
        ),
        result = await readEnvelopeIntegrity(
          storageDir,
          createEnvelopeBaseline([]),
          { fileSystem: seam.fileSystem }
        )

      expect(result.valid).toEqual([])
      expect(result.pending).toEqual([])
      expect(result.issues[0]?.code).toBe(
        EnvelopeIntegrityIssueCode.StorageRootChanged
      )
      expect(seam.observations.readdirCount).toBe(2)
    } finally {
      removeStorageDir(storageDir)
    }
  })

  it.each(SnapshotMutations)(
    "rejects %s even when root stat fields stay frozen",
    async (_label, mutate) => {
      const storageDir = createStorageDir(),
        pair = writeEnvelopePair(storageDir)
      try {
        const seam = frozenSnapshotFileSystem(storageDir, () => mutate(pair)),
          result = await readEnvelopeIntegrity(
            storageDir,
            createEnvelopeBaseline([]),
            { fileSystem: seam.fileSystem }
          )

        expect(result.valid).toEqual([])
        expect(result.pending).toEqual([])
        expect(result.issues[0]?.code).toBe(
          EnvelopeIntegrityIssueCode.StorageRootChanged
        )
        expect(seam.observations.readdirCount).toBe(2)
      } finally {
        removeStorageDir(storageDir)
      }
    }
  )

  it("accepts an unchanged snapshot across both revalidations", async () => {
    const storageDir = createStorageDir()
    writeEnvelopePair(storageDir)
    try {
      const seam = frozenSnapshotFileSystem(storageDir, () => undefined),
        result = await readEnvelopeIntegrity(
          storageDir,
          createEnvelopeBaseline([]),
          { fileSystem: seam.fileSystem }
        )

      expect(result.valid).toHaveLength(1)
      expect(result.pending).toEqual([])
      expect(result.issues).toEqual([])
      expect(seam.observations.readdirCount).toBe(3)
    } finally {
      removeStorageDir(storageDir)
    }
  })

  it("does not capture a baseline from a mixed filename generation", async () => {
    const storageDir = createStorageDir(),
      pair = writeEnvelopePair(storageDir)
    Fs.rmSync(pair.metadataPath)
    try {
      const seam = frozenSnapshotFileSystem(storageDir, () =>
          Fs.writeFileSync(pair.metadataPath, pair.metadataBytes)
        ),
        result = await captureEnvelopeBaseline(storageDir, {
          fileSystem: seam.fileSystem
        })

      expect(result).toMatchObject({
        kind: "failed",
        issues: [{ code: EnvelopeIntegrityIssueCode.StorageRootChanged }]
      })
      expect(seam.observations.readdirCount).toBe(2)
    } finally {
      removeStorageDir(storageDir)
    }
  })
})

function frozenSnapshotFileSystem(
  storageDir: string,
  mutateAfterFirstRead: () => void
): {
  readonly fileSystem: EnvelopeIntegrityFileSystem
  readonly observations: { readdirCount: number }
} {
  const frozenStat = Fs.lstatSync(storageDir, { bigint: true }),
    observations = { readdirCount: 0 },
    base = createNodeFileSystem({
      readdir: async (_path, read) => {
        const filenames = await read()
        observations.readdirCount += 1
        if (observations.readdirCount === 1) mutateAfterFirstRead()
        return filenames
      }
    })
  return {
    observations,
    fileSystem: {
      ...base,
      lstat: path =>
        path === storageDir ? Promise.resolve(frozenStat) : base.lstat(path),
      openDirectory: async path => {
        const root = await base.openDirectory(path)
        return path === storageDir
          ? { ...root, stat: async () => frozenStat }
          : root
      }
    }
  }
}
