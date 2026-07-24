import * as Fs from "node:fs"
import * as Path from "node:path"

import { AtomicFile } from "@wireio/debugging-shared"
import {
  OppStressRampEvidenceModeKind,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidencePersistence,
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode,
  parseRunEvidenceManifest,
  runOppStressRamp
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocationOptions,
  createPersistenceWorkspace,
  successfulSetup
} from "./run-evidence/runEvidencePersistenceTestSupport.js"

const Endpoint = RunEvidenceEndpoint.OutpostEthereumDepot,
  Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 2,
    phaseTimeoutMs: 30_000
  } as const

describe("runOppStressRamp failure publication faults", () => {
  it("propagates the exact iteration publication error", async () => {
    // Given: failure classification succeeds but immutable iteration publication fails.
    const harness = await createFaultHarness(),
      publicationError = new RunEvidencePersistenceError(
        RunEvidencePersistenceErrorCode.InvalidState,
        "iteration fault"
      ),
      terminal = jest.spyOn(harness.persistence, "publishTerminal")
    jest
      .spyOn(harness.persistence, "publishIteration")
      .mockRejectedValue(publicationError)
    try {
      // When: the callback rejection reaches the publication boundary.
      const run = rejectedRamp(harness.persistence)

      // Then: persistence authority wins and no terminal finalization is claimed.
      await expect(run).rejects.toBe(publicationError)
      expect(terminal).not.toHaveBeenCalled()
      expect(readManifest(harness.persistence.runDirectory)).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Running,
        records: { iterations: [], terminal: null }
      })
    } finally {
      harness.cleanup()
    }
  })

  it("propagates the AtomicFile manifest checkpoint cause", async () => {
    // Given: immutable iteration publication succeeds before manifest replacement fails.
    const renameError = Object.assign(new Error("manifest fault"), {
        code: "ERENAME"
      }),
      harness = await createFaultHarness(renameError)
    try {
      // When: the running manifest checkpoint reaches its atomic rename.
      let thrown: unknown = null
      try {
        await rejectedRamp(harness.persistence)
      } catch (error) {
        thrown = error
      }

      // Then: the exact AtomicFile diagnostic propagates without repair or terminal write.
      expect(thrown).toBeInstanceOf(AtomicFile.PublishError)
      if (!(thrown instanceof AtomicFile.PublishError))
        throw new Error("AtomicFile publication error expected")
      expect(thrown.stage).toBe(AtomicFile.Stage.Rename)
      expect(thrown.cause).toBe(renameError)
      expect(
        Fs.existsSync(
          Path.join(
            harness.persistence.runDirectory,
            RunEvidencePath.Iterations,
            "000000.json"
          )
        )
      ).toBe(true)
      expect(
        Fs.existsSync(
          Path.join(harness.persistence.runDirectory, RunEvidencePath.Terminal)
        )
      ).toBe(false)
      expect(readManifest(harness.persistence.runDirectory)).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Running,
        records: { iterations: [], terminal: null }
      })
    } finally {
      harness.cleanup()
    }
  })

  it("propagates the exact terminal publication error after iteration checkpoint", async () => {
    // Given: the breakage iteration can checkpoint but terminal publication fails.
    const harness = await createFaultHarness(),
      publicationError = new RunEvidencePersistenceError(
        RunEvidencePersistenceErrorCode.InvalidState,
        "terminal fault"
      )
    jest
      .spyOn(harness.persistence, "publishTerminal")
      .mockRejectedValue(publicationError)
    try {
      // When: the controller attempts terminal publication.
      const run = rejectedRamp(harness.persistence)

      // Then: no result is returned and the valid running checkpoint remains.
      await expect(run).rejects.toBe(publicationError)
      const manifest = readManifest(harness.persistence.runDirectory)
      expect(manifest.lifecycle).toBe(RunEvidenceLifecycle.Running)
      expect(manifest.records.iterations.map(ref => ref.path)).toEqual([
        `${RunEvidencePath.Iterations}/000000.json`
      ])
      expect(manifest.records.terminal).toBeNull()
      expect(
        Fs.existsSync(
          Path.join(harness.persistence.runDirectory, RunEvidencePath.Terminal)
        )
      ).toBe(false)
    } finally {
      harness.cleanup()
    }
  })
})

async function createFaultHarness(renameError: Error | null = null) {
  const workspace = createPersistenceWorkspace()
  let enabled = false
  const dependencies =
    renameError === null
      ? allocationDependencies()
      : {
          ...allocationDependencies(),
          atomicFileDependencies: {
            fileSystem: {
              rename: (tempFile: string, finalFile: string) =>
                enabled && finalFile.endsWith(RunEvidencePath.Manifest)
                  ? Promise.reject(renameError)
                  : Fs.promises.rename(tempFile, finalFile)
            }
          }
        }
  const persistence = await RunEvidencePersistence.allocate(
    {
      ...allocationOptions(workspace),
      rampConfig: Config,
      requiredEndpoints: [Endpoint]
    },
    dependencies
  )
  await persistence.captureClusterConfig()
  await persistence.publishSetup(successfulSetup())
  enabled = true
  return { persistence, cleanup: workspace.cleanup }
}

function rejectedRamp(persistence: RunEvidencePersistence) {
  const cause = new Error("callback failed")
  return runOppStressRamp({
    evidenceMode: OppStressRampEvidenceModeKind.SchemaV1,
    persistence,
    clock: jest.fn().mockReturnValueOnce(103).mockReturnValueOnce(104),
    runIteration: () => Promise.reject(cause)
  })
}

function readManifest(runDirectory: string) {
  const parsed = parseRunEvidenceManifest(
    JSON.parse(
      Fs.readFileSync(Path.join(runDirectory, RunEvidencePath.Manifest), "utf8")
    )
  )
  if ("error" in parsed) throw new Error("manifest fixture must parse")
  return parsed.value
}
