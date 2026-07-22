import Fs from "node:fs"
import Path from "node:path"

import {
  RunEvidenceClusterConfigState,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidencePersistence,
  serializeRunEvidenceJson,
  parseRunEvidenceManifest
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocationOptions,
  createPersistenceWorkspace,
  readJson,
  sha256,
  successfulSetup,
  TestEndpoint,
  TestRunId
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence allocation and lifecycle", () => {
  it("allocates a durable parser-valid initializing run outside the cluster", async () => {
    // Given: an existing caller-owned external evidence root.
    const workspace = createPersistenceWorkspace()
    try {
      // When: a deterministic run is allocated before setup starts.
      const persistence = await RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies()
        ),
        manifestFile = Path.join(
          persistence.runDirectory,
          RunEvidencePath.Manifest
        ),
        manifestBytes = Fs.readFileSync(manifestFile),
        manifest = readJson(manifestFile)
      // Then: identity, layout, parser state, bytes, and permissions are canonical.
      expect(persistence.runId).toBe(TestRunId)
      expect(persistence.runDirectory).toBe(
        Path.join(workspace.evidenceRoot, "runs", TestRunId)
      )
      expect(
        Path.relative(
          workspace.clusterPath,
          persistence.runDirectory
        ).startsWith(`..${Path.sep}`)
      ).toBe(true)
      expect(parseRunEvidenceManifest(manifest).ok).toBe(true)
      expect(manifest).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Initializing,
        startedAtMs: "100",
        updatedAtMs: "100",
        clusterPath: Path.resolve(workspace.clusterPath),
        requiredEndpoints: [TestEndpoint],
        clusterConfigSnapshot: { kind: RunEvidenceClusterConfigState.Pending },
        artifacts: []
      })
      expect(manifestBytes.at(-1)).toBe(10)
      expect(Fs.statSync(manifestFile).mode & 0o777).toBe(0o600)
      expect(Fs.statSync(persistence.runDirectory).mode & 0o777).toBe(0o700)
    } finally {
      workspace.cleanup()
    }
  })

  it("writes deterministic equivalent JSON bytes and record digests", async () => {
    // Given: two roots with equivalent run input and the same deterministic UUID.
    const first = createPersistenceWorkspace(),
      second = createPersistenceWorkspace()
    try {
      const firstPersistence = await RunEvidencePersistence.allocate(
          allocationOptions(first),
          allocationDependencies()
        ),
        secondPersistence = await RunEvidencePersistence.allocate(
          allocationOptions(second),
          allocationDependencies()
        )
      await Promise.all([
        firstPersistence.captureClusterConfig(),
        secondPersistence.captureClusterConfig()
      ])
      // When: equivalent setup values with different insertion order are published.
      const setup = successfulSetup(),
        reorderedSetup = {
          clusterConfigCreated: setup.clusterConfigCreated,
          endedAtMs: setup.endedAtMs,
          startedAtMs: setup.startedAtMs,
          status: setup.status,
          stage: setup.stage,
          schemaVersion: setup.schemaVersion
        },
        [firstRef, secondRef] = await Promise.all([
          firstPersistence.publishSetup(setup),
          secondPersistence.publishSetup(reorderedSetup)
        ]),
        firstBytes = Fs.readFileSync(
          Path.join(firstPersistence.runDirectory, RunEvidencePath.Setup)
        ),
        secondBytes = Fs.readFileSync(
          Path.join(secondPersistence.runDirectory, RunEvidencePath.Setup)
        )
      // Then: lexical object ordering and the one-newline policy are byte stable.
      expect(secondBytes).toEqual(firstBytes)
      expect(firstRef.sha256).toBe(sha256(firstBytes))
      expect(secondRef.sha256).toBe(firstRef.sha256)
      expect(firstBytes.at(-1)).toBe(10)
      expect(firstBytes.subarray(0, -1).includes(10)).toBe(false)
    } finally {
      first.cleanup()
      second.cleanup()
    }
  })

  it("serializes lexical JSON, bigint decimals, and rejects unsupported values", () => {
    // Given: object keys out of order, meaningful array order, and a large bigint.
    const input = { zeta: 1, alpha: [2n, "first", { beta: true, alpha: null }] }
    // When: the public digest serializer commits the value to bytes.
    const bytes = serializeRunEvidenceJson(input)
    // Then: keys are recursive-lexical, arrays retain order, bigint is decimal text.
    expect(bytes.toString()).toBe(
      '{"alpha":["2","first",{"alpha":null,"beta":true}],"zeta":1}\n'
    )
    expect(() => serializeRunEvidenceJson({ value: undefined })).toThrow(
      "unsupported JSON value type"
    )
    expect(() =>
      serializeRunEvidenceJson({ value: Number.MAX_SAFE_INTEGER + 1 })
    ).toThrow("use bigint")
  })
})
