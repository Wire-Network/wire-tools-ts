import * as Path from "node:path"

import type {
  EnvelopeIntegrityFileHandle,
  EnvelopeIntegrityFileSystem
} from "@wireio/debugging-shared"
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

type FaultOperation =
  | "stat_before_read"
  | "read"
  | "stat_after_read"
  | "verify_open"
  | "verify_stat"
  | "close"

function faultingFileSystem(
  target: string,
  operation: FaultOperation
): EnvelopeIntegrityFileSystem {
  const base = createNodeFileSystem(),
    openCounts = new Map<string, number>(),
    targetBasename = Path.basename(target)
  return {
    ...base,
    openDirectory: async path => {
      const directory = await base.openDirectory(path)
      return {
        ...directory,
        openChild: async basename => {
          const openCount = (openCounts.get(basename) ?? 0) + 1
          openCounts.set(basename, openCount)
          if (
            basename === targetBasename &&
            operation === "verify_open" &&
            openCount === 2
          ) {
            throw Object.assign(new Error(operation), { code: "EIO" })
          }
          return wrapFaultHandle(
            await directory.openChild(basename),
            basename === targetBasename,
            { openCount, operation }
          )
        }
      }
    }
  }
}

function wrapFaultHandle(
  handle: EnvelopeIntegrityFileHandle,
  targeted: boolean,
  fault: { readonly openCount: number; readonly operation: FaultOperation }
): EnvelopeIntegrityFileHandle {
  let statCount = 0
  return {
    stat: async () => {
      statCount += 1
      const current =
        fault.openCount === 1
          ? statCount === 1
            ? "stat_before_read"
            : "stat_after_read"
          : "verify_stat"
      if (targeted && fault.operation === current) {
        throw Object.assign(new Error(current), { code: "EIO" })
      }
      return handle.stat()
    },
    readFile: async () => {
      if (targeted && fault.operation === "read") {
        throw Object.assign(new Error("read"), { code: "EIO" })
      }
      return handle.readFile()
    },
    close: async () => {
      await handle.close()
      if (targeted && fault.operation === "close") {
        throw Object.assign(new Error("close"), { code: "EIO" })
      }
    }
  }
}

describe("EnvelopeIntegrityReader filesystem faults", () => {
  it.each(["data", "metadata"])(
    "normalizes every %s sidecar operation",
    async sidecar => {
      const storageDir = createStorageDir()
      try {
        const pair = writeEnvelopePair(storageDir),
          target = sidecar === "data" ? pair.dataPath : pair.metadataPath,
          operations = [
            "stat_before_read",
            "read",
            "stat_after_read",
            "verify_open",
            "verify_stat",
            "close"
          ] as const
        await Promise.all(
          operations.map(async operation => {
            const result = await readEnvelopeIntegrity(
              storageDir,
              createEnvelopeBaseline([]),
              { fileSystem: faultingFileSystem(target, operation) }
            )
            expect(result.valid).toEqual([])
            expect(result.issues[0]).toMatchObject({
              code: operation.startsWith("verify_")
                ? sidecar === "data"
                  ? EnvelopeIntegrityIssueCode.DataSidecarChanged
                  : EnvelopeIntegrityIssueCode.MetadataSidecarChanged
                : sidecar === "data"
                  ? EnvelopeIntegrityIssueCode.DataReadFailed
                  : EnvelopeIntegrityIssueCode.MetadataReadFailed,
              context: { error: { operation } }
            })
          })
        )
      } finally {
        removeStorageDir(storageDir)
      }
    }
  )
})
