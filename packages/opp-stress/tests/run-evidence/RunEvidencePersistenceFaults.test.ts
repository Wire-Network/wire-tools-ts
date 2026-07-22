import Fs from "node:fs"
import Path from "node:path"

import { AtomicFile } from "@wireio/debugging-shared"
import {
  RunEvidencePath,
  RunEvidencePersistence,
  parseRunEvidenceManifest
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocationOptions,
  createPersistenceWorkspace,
  readJson,
  successfulSetup
} from "./runEvidencePersistenceTestSupport.js"

type FaultCase = {
  readonly label: string
  readonly stage: AtomicFile.Stage
  readonly committed: boolean
  readonly fileSystem: (
    enabled: () => boolean
  ) => Partial<AtomicFile.FileSystem>
}

const fault = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code }),
  fileHandleFault = (
    enabled: () => boolean,
    method: "writeFile" | "sync"
  ): Partial<AtomicFile.FileSystem> => ({
    open: async (file, flags, mode) => {
      const handle = await Fs.promises.open(file, flags, mode)
      if (!enabled() || flags !== "wx" || !file.includes(".setup.json."))
        return handle
      return {
        writeFile:
          method === "writeFile"
            ? async () => Promise.reject(fault("EWRITE"))
            : handle.writeFile.bind(handle),
        sync:
          method === "sync"
            ? async () => Promise.reject(fault("EFSYNC"))
            : handle.sync.bind(handle),
        close: handle.close.bind(handle)
      }
    }
  }),
  FaultCases: readonly FaultCase[] = [
    {
      label: "temp write",
      stage: AtomicFile.Stage.TempWrite,
      committed: false,
      fileSystem: enabled => fileHandleFault(enabled, "writeFile")
    },
    {
      label: "file sync",
      stage: AtomicFile.Stage.FileSync,
      committed: false,
      fileSystem: enabled => fileHandleFault(enabled, "sync")
    },
    {
      label: "link",
      stage: AtomicFile.Stage.Link,
      committed: false,
      fileSystem: enabled => ({
        link: async (tempFile, finalFile) =>
          enabled() && finalFile.endsWith(RunEvidencePath.Setup)
            ? Promise.reject(fault("ELINK"))
            : Fs.promises.link(tempFile, finalFile)
      })
    },
    {
      label: "rename",
      stage: AtomicFile.Stage.Rename,
      committed: false,
      fileSystem: enabled => ({
        rename: async (tempFile, finalFile) =>
          enabled() && finalFile.endsWith(RunEvidencePath.Manifest)
            ? Promise.reject(fault("ERENAME"))
            : Fs.promises.rename(tempFile, finalFile)
      })
    },
    {
      label: "temp unlink",
      stage: AtomicFile.Stage.TempUnlink,
      committed: true,
      fileSystem: enabled => ({
        unlink: async file =>
          enabled() && file.includes(".setup.json.")
            ? Promise.reject(fault("EUNLINK"))
            : Fs.promises.unlink(file)
      })
    },
    {
      label: "directory sync",
      stage: AtomicFile.Stage.DirectorySync,
      committed: true,
      fileSystem: enabled => ({
        open: async (file, flags, mode) => {
          const handle = await Fs.promises.open(file, flags, mode)
          if (!enabled() || flags !== "r") return handle
          return {
            writeFile: handle.writeFile.bind(handle),
            sync: async () => Promise.reject(fault("EDIRSYNC")),
            close: handle.close.bind(handle)
          }
        }
      })
    }
  ]

describe("RunEvidencePersistence AtomicFile propagation", () => {
  it.each(FaultCases)(
    "propagates $label failures without false manifest advancement",
    async ({ stage, committed, fileSystem }) => {
      // Given: allocation and config capture complete before fault activation.
      const workspace = createPersistenceWorkspace()
      let enabled = false
      try {
        const persistence = await RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          {
            ...allocationDependencies(),
            atomicFileDependencies: {
              fileSystem: fileSystem(() => enabled),
              tempToken: () => "fault-token"
            }
          }
        )
        await persistence.captureClusterConfig()
        enabled = true
        // When: setup publication reaches the injected AtomicFile stage.
        let thrown: unknown = null
        try {
          await persistence.publishSetup(successfulSetup())
        } catch (error) {
          thrown = error
        }
        // Then: the exact AtomicFile diagnostic propagates and manifest stays valid.
        expect(thrown).toBeInstanceOf(AtomicFile.PublishError)
        expect(thrown).toMatchObject({ stage, committed })
        const manifest = readJson(
          Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
        )
        expect(parseRunEvidenceManifest(manifest).ok).toBe(true)
        expect(manifest).toMatchObject({
          records: {
            setup: { kind: "pending" },
            iterations: [],
            terminal: null
          }
        })
        const setupFile = Path.join(
          persistence.runDirectory,
          RunEvidencePath.Setup
        )
        expect(Fs.existsSync(setupFile)).toBe(
          committed || stage === AtomicFile.Stage.Rename
        )
        if (Fs.existsSync(setupFile)) {
          expect(Fs.readFileSync(setupFile, "utf8").endsWith("\n")).toBe(true)
        }
        if (
          thrown instanceof AtomicFile.PublishError &&
          stage === AtomicFile.Stage.TempUnlink
        ) {
          expect(thrown.residualTempFile).not.toBeNull()
          expect(Fs.existsSync(String(thrown.residualTempFile))).toBe(true)
        }
        if (committed || stage === AtomicFile.Stage.Rename) {
          await expect(
            persistence.publishSetup(successfulSetup())
          ).rejects.toBe(thrown)
        }
      } finally {
        workspace.cleanup()
      }
    }
  )
})
