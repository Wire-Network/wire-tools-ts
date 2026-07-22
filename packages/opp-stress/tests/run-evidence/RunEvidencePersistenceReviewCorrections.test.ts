import Fs from "node:fs"
import Path from "node:path"

import {
  RunEvidencePath,
  RunEvidencePersistence,
  RunEvidencePersistenceErrorCode
} from "@wireio/test-opp-stress"

import {
  allocateRunningPersistence,
  allocationDependencies,
  allocationOptions,
  artifactCapture,
  createPersistenceWorkspace,
  readJson,
  TestRunId,
  writeOppPair
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence review-1 corrections", () => {
  it("T8-R1-EXTERNAL-EVIDENCE-PLACEMENT uses the fixed sibling root", async () => {
    // Given: allocation input still exposes an unrelated caller-selected root.
    const workspace = createPersistenceWorkspace()
    try {
      // When: the run is allocated before setup.
      const persistence = await RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies()
        ),
        expectedRoot = `${Path.resolve(
          workspace.clusterPath
        )}-swap-stress-evidence`
      // Then: only the fixed sibling survives force recreation of the cluster.
      expect(persistence.runDirectory).toBe(
        Path.join(expectedRoot, "runs", TestRunId)
      )
      Fs.rmSync(workspace.clusterPath, { recursive: true, force: true })
      expect(
        Fs.existsSync(
          Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
        )
      ).toBe(true)
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects a symlink occupying the fixed sibling evidence root", async () => {
    // Given: the approved sibling path aliases an attacker-controlled directory.
    const workspace = createPersistenceWorkspace(),
      evidenceRoot = `${Path.resolve(
        workspace.clusterPath
      )}-swap-stress-evidence`,
      target = Path.join(workspace.root, "evidence-target")
    Fs.mkdirSync(target)
    Fs.symlinkSync(target, evidenceRoot)
    try {
      // When/Then: allocation rejects the unsafe existing root before setup.
      await expect(
        RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies()
        )
      ).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.UnsafeSource
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects a symlinked cluster path before allocating evidence", async () => {
    // Given: the allocation cluster path is a symlink alias of a real cluster.
    const workspace = createPersistenceWorkspace(),
      clusterAlias = Path.join(workspace.root, "cluster-alias")
    Fs.symlinkSync(workspace.clusterPath, clusterAlias)
    try {
      // When/Then: canonical cluster identity is required before root derivation.
      await expect(
        RunEvidencePersistence.allocate(
          { ...allocationOptions(workspace), clusterPath: clusterAlias },
          allocationDependencies()
        )
      ).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.UnsafeSource
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects a realpath alias at the fixed sibling evidence root", async () => {
    // Given: the fixed lexical sibling resolves to the allocated cluster identity.
    const workspace = createPersistenceWorkspace(),
      evidenceRoot = `${Path.resolve(
        workspace.clusterPath
      )}-swap-stress-evidence`
    try {
      // When/Then: allocation rejects the physical alias before manifest creation.
      await expect(
        RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies({
            realpath: file =>
              file === evidenceRoot
                ? Promise.resolve(Path.resolve(workspace.clusterPath))
                : Fs.promises.realpath(file)
          })
        )
      ).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.UnsafeSource
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("T8-R1-CANONICAL-SOURCE-ROOT cannot redirect supplied bytes", async () => {
    // Given: canonical exact bytes and a different valid off-cluster pair.
    const workspace = createPersistenceWorkspace(),
      attackerRoot = Path.join(workspace.root, "attacker-controlled"),
      attackerBaseKey = writeOppPair(attackerRoot, ["operator.attacker"]),
      baseKey = writeOppPair(workspace.oppRoot, ["operator.canonical"]),
      request = artifactCapture(workspace.oppRoot, baseKey)
    try {
      const persistence = await allocateRunningPersistence(workspace),
        runtimeRequest = { ...request, sourceRoot: attackerRoot }
      expect(attackerBaseKey).toBe(baseKey)
      // When: capture receives an extra attacker-selected source path.
      await persistence.beginObservation("103").captureArtifact(runtimeRequest)
      // Then: the path cannot redirect the canonical snapshot.
      expect(
        readJson(Path.join(persistence.runDirectory, RunEvidencePath.Manifest))
      ).toMatchObject({
        artifacts: [{ lastAcceptedBatchOpNames: ["operator.canonical"] }]
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("T8-R1-SOURCE-ROOT-REPLACEMENT cannot replace a supplied snapshot", async () => {
    // Given: exact valid bytes captured before their root path is replaced.
    const workspace = createPersistenceWorkspace(),
      baseKey = writeOppPair(workspace.oppRoot, ["operator.a"]),
      request = artifactCapture(workspace.oppRoot, baseKey),
      dataFile = Path.join(workspace.oppRoot, `${baseKey}.data`),
      metadataFile = Path.join(workspace.oppRoot, `${baseKey}.metadata`),
      displacedRoot = Path.join(workspace.root, "validated-generation"),
      persistence = await allocateRunningPersistence(workspace)
    try {
      // When: the source root names a malformed replacement before persistence.
      Fs.renameSync(workspace.oppRoot, displacedRoot)
      Fs.mkdirSync(workspace.oppRoot, { recursive: true })
      Fs.writeFileSync(dataFile, Buffer.from("replacement"))
      Fs.writeFileSync(metadataFile, Buffer.from([0xff]))
      await persistence.beginObservation("103").captureArtifact(request)
      // Then: only the validated generation advances the manifest.
      expect(
        readJson(Path.join(persistence.runDirectory, RunEvidencePath.Manifest))
      ).toMatchObject({
        artifacts: [{ lastAcceptedBatchOpNames: ["operator.a"] }]
      })
    } finally {
      workspace.cleanup()
    }
  })
})
