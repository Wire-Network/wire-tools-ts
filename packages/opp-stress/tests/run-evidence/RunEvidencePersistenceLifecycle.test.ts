import Fs from "node:fs"
import Path from "node:path"

import {
  RunEvidenceClusterConfigState,
  RunEvidenceConfigUnavailableReason,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidencePersistence,
  parseRunEvidenceIteration,
  parseRunEvidenceManifest,
  parseRunEvidenceSetup,
  parseRunEvidenceTerminal
} from "@wireio/test-opp-stress"

import {
  allocateRunningPersistence,
  allocationDependencies,
  allocationOptions,
  breakageIteration,
  createPersistenceWorkspace,
  failedSetup,
  failedTerminal,
  iterationRecord,
  readJson,
  setupFailedTerminal,
  sha256,
  successfulSetup,
  terminalRecord
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence lifecycle", () => {
  it.each([
    RunEvidenceLifecycle.Saturated,
    RunEvidenceLifecycle.Incomplete
  ] as const)(
    "publishes parser-valid %s lifecycle checkpoints",
    async lifecycle => {
      // Given: successful setup with a captured exact config snapshot.
      const workspace = createPersistenceWorkspace()
      try {
        const persistence = await allocateRunningPersistence(workspace),
          configFile = Path.join(
            persistence.runDirectory,
            RunEvidencePath.ClusterConfigSnapshot
          ),
          setupFile = Path.join(persistence.runDirectory, RunEvidencePath.Setup)
        expect(Fs.readFileSync(configFile)).toEqual(workspace.configBytes)
        expect(parseRunEvidenceSetup(readJson(setupFile)).ok).toBe(true)
        // When: iteration zero and its matching terminal are published.
        const saturated = lifecycle === RunEvidenceLifecycle.Saturated,
          iterationRef = await persistence.publishIteration(
            iterationRecord(
              0,
              saturated
                ? RunEvidenceIterationOutcome.Saturated
                : RunEvidenceIterationOutcome.NotSaturated
            )
          ),
          terminal = terminalRecord(lifecycle, [iterationRef]),
          terminalRef = await persistence.publishTerminal(terminal),
          persistedIteration = parseRunEvidenceIteration(
            readJson(Path.join(persistence.runDirectory, iterationRef.path))
          ),
          manifest = readJson(
            Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
          )
        // Then: every record, digest ref, and terminal manifest parses cleanly.
        expect(persistedIteration.ok).toBe(true)
        if (!persistedIteration.ok)
          throw new Error("persisted iteration must be parser-valid")
        expect(persistedIteration.value.phases[0]?.baseline.baseKeys).toEqual([])
        expect(
          parseRunEvidenceTerminal(
            readJson(Path.join(persistence.runDirectory, terminalRef.path))
          ).ok
        ).toBe(true)
        expect(parseRunEvidenceManifest(manifest).ok).toBe(true)
        expect(manifest).toMatchObject({
          lifecycle,
          records: { iterations: [iterationRef], terminal: terminalRef },
          clusterConfigSnapshot: {
            kind: RunEvidenceClusterConfigState.Captured,
            sha256: sha256(workspace.configBytes)
          }
        })
        await expect(
          persistence.publishTerminal(terminal)
        ).rejects.toMatchObject({
          name: "RunEvidencePersistenceError"
        })
      } finally {
        workspace.cleanup()
      }
    }
  )

  it.each([false, true])(
    "publishes setup_failed when config-created is %s",
    async clusterConfigCreated => {
      // Given: an allocated run, optionally with a committed config snapshot.
      const workspace = createPersistenceWorkspace()
      try {
        const persistence = await RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies()
        )
        if (clusterConfigCreated) await persistence.captureClusterConfig()
        // When: setup and its setup-failed terminal commit.
        await persistence.publishSetup(failedSetup(clusterConfigCreated))
        const terminalRef = await persistence.publishTerminal(
            setupFailedTerminal()
          ),
          manifest = readJson(
            Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
          )
        // Then: unavailable and captured config variants remain parser-valid.
        expect(parseRunEvidenceManifest(manifest).ok).toBe(true)
        expect(manifest).toMatchObject({
          lifecycle: RunEvidenceLifecycle.SetupFailed,
          records: { iterations: [], terminal: terminalRef },
          clusterConfigSnapshot: clusterConfigCreated
            ? { kind: RunEvidenceClusterConfigState.Captured }
            : {
                kind: RunEvidenceClusterConfigState.Unavailable,
                reason:
                  RunEvidenceConfigUnavailableReason.ClusterConfigNotCreated
              }
        })
      } finally {
        workspace.cleanup()
      }
    }
  )

  it("publishes a parser-valid failed terminal after iteration breakage", async () => {
    // Given: a running lifecycle with successful setup.
    const workspace = createPersistenceWorkspace()
    try {
      const persistence = await allocateRunningPersistence(workspace)
      // When: a breakage iteration and failed terminal are committed.
      const iterationRef = await persistence.publishIteration(
          breakageIteration(0)
        ),
        terminalRef = await persistence.publishTerminal(
          failedTerminal([iterationRef])
        ),
        manifest = readJson(
          Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
        )
      // Then: immutable refs and failure preservation form valid schema v1.
      expect(parseRunEvidenceManifest(manifest).ok).toBe(true)
      expect(manifest).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Failed,
        preserveCluster: true,
        records: { iterations: [iterationRef], terminal: terminalRef }
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects duplicate lifecycle names and iteration gaps", async () => {
    // Given: one committed setup and no iterations.
    const workspace = createPersistenceWorkspace()
    try {
      const persistence = await allocateRunningPersistence(workspace)
      // When/Then: duplicate setup and a noncontiguous index are rejected pre-write.
      await expect(
        persistence.publishSetup(successfulSetup())
      ).rejects.toMatchObject({
        name: "RunEvidencePersistenceError"
      })
      await expect(
        persistence.publishIteration(iterationRecord(1))
      ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
      expect(
        Fs.existsSync(
          Path.join(
            persistence.runDirectory,
            RunEvidencePath.Iterations,
            "000001.json"
          )
        )
      ).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects a terminal decision that disagrees with the last iteration", async () => {
    // Given: a committed not-saturated iteration.
    const workspace = createPersistenceWorkspace()
    try {
      const persistence = await allocateRunningPersistence(workspace),
        iterationRef = await persistence.publishIteration(iterationRecord(0))
      // When: a parser-valid saturated terminal contradicts that iteration.
      const contradictory = terminalRecord(RunEvidenceLifecycle.Saturated, [
        iterationRef
      ])
      // Then: persistence rejects the cross-record disagreement before terminal write.
      await expect(
        persistence.publishTerminal(contradictory)
      ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
      expect(
        Fs.existsSync(
          Path.join(persistence.runDirectory, RunEvidencePath.Terminal)
        )
      ).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })
})
