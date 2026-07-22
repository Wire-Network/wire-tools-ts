import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceLifecycle,
  RunEvidencePersistence,
  RunEvidenceSaturationStrategy,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { EnvelopeRouteHarness } from "./envelopeRouteTestSupport.js"
import {
  Operators,
  RequiredEndpoint,
  cleanupCompletedRun,
  createCompletedRun
} from "./oppStressIntegrityTestSupport.js"

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

describe("OPP stress evidence integrity integration", () => {
  it("verifies concurrent HTTP publication as saturated offline evidence", async () => {
    const fixture = await createCompletedRun()
    try {
      expect(fixture.responses.map(response => response.status)).toEqual([
        200, 200, 200
      ])
      expect(
        fixture.responses.map(response => response.body.result?.key)
      ).toEqual([fixture.key, fixture.key, fixture.key])
      expect(fixture.metadata.batchOpNames).toEqual(Operators)
      expect(fixture.metrics).toMatchObject({
        endpoint: RequiredEndpoint,
        strategy: RunEvidenceSaturationStrategy.Rollover,
        saturated: true,
        envelopeCount: 1,
        epochEnvelopeIndexes: [1],
        health: { kind: OppEnvelopeTelemetryHealthKind.Healthy }
      })
      expect(fixture.evidence.kind).toBe("recorded")
      const artifact = fixture.evidence.artifacts[0]
      if (artifact === undefined)
        throw new TypeError("captured artifact expected")
      expect(fixture.evidence.artifactRefs).toEqual([
        artifact.immutableRefs.data.path,
        artifact.immutableRefs.metadata.path
      ])
      ;(
        [artifact.immutableRefs.data, artifact.immutableRefs.metadata] as const
      ).forEach(ref =>
        expect(
          sha256(
            Fs.readFileSync(
              Path.join(fixture.persistence.runDirectory, ref.path)
            )
          )
        ).toBe(ref.sha256)
      )

      const report = verifyRunEvidence(fixture.persistence.runDirectory)
      expect(report).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.Saturated,
        lifecycle: RunEvidenceLifecycle.Saturated,
        verifiedSaturated: true,
        issues: []
      })
      expect(report.publisherClaims).toHaveLength(1)
      expect(
        [...(report.publisherClaims[0]?.lastAcceptedBatchOpNames ?? [])].sort()
      ).toEqual([...Operators])
    } finally {
      await cleanupCompletedRun(fixture)
    }
  })

  it("verifies immutable evidence after live route source mutation", async () => {
    const fixture = await createCompletedRun()
    try {
      Fs.writeFileSync(
        Path.join(fixture.harness.storageDir, `${fixture.key}.data`),
        "mutated-live-source"
      )
      Fs.rmSync(
        Path.join(fixture.harness.storageDir, `${fixture.key}.metadata`)
      )
      Fs.rmSync(fixture.harness.clusterPath, { recursive: true, force: true })

      expect(verifyRunEvidence(fixture.persistence.runDirectory)).toMatchObject(
        {
          valid: true,
          verdict: RunEvidenceVerificationVerdict.Saturated,
          issues: []
        }
      )
    } finally {
      await cleanupCompletedRun(fixture)
    }
  })

  it("rejects tampered snapshotted evidence data", async () => {
    const fixture = await createCompletedRun()
    try {
      const artifact = fixture.evidence.artifacts[0]
      if (artifact === undefined)
        throw new TypeError("captured artifact expected")
      Fs.writeFileSync(
        Path.join(
          fixture.persistence.runDirectory,
          artifact.immutableRefs.data.path
        ),
        "tampered-evidence"
      )

      const report = verifyRunEvidence(fixture.persistence.runDirectory)
      expect(report.valid).toBe(false)
      expect(report.verdict).toBe(RunEvidenceVerificationVerdict.Invalid)
      expect(report.issues).not.toHaveLength(0)
    } finally {
      await cleanupCompletedRun(fixture)
    }
  })

  it("removes external evidence when fixture failure cleanup cannot stop", async () => {
    const harness = await EnvelopeRouteHarness.start(
        "opp-stress-cleanup-failure"
      ),
      evidenceRoot = `${harness.clusterPath}-swap-stress-evidence`,
      originalStop = harness.stop.bind(harness),
      stopError = new TypeError("stop failed")
    Fs.mkdirSync(evidenceRoot)
    jest.spyOn(EnvelopeRouteHarness, "start").mockResolvedValueOnce(harness)
    jest
      .spyOn(RunEvidencePersistence, "allocate")
      .mockRejectedValueOnce(new TypeError("allocation failed"))
    jest.spyOn(harness, "stop").mockRejectedValueOnce(stopError)
    try {
      await expect(createCompletedRun()).rejects.toBe(stopError)
      expect(Fs.existsSync(evidenceRoot)).toBe(false)
    } finally {
      jest.restoreAllMocks()
      await originalStop()
      Fs.rmSync(evidenceRoot, { recursive: true, force: true })
    }
  })

  it("removes external evidence when completed-run cleanup cannot stop", async () => {
    const fixture = await createCompletedRun(),
      originalStop = fixture.harness.stop.bind(fixture.harness),
      stopError = new TypeError("stop failed")
    jest.spyOn(fixture.harness, "stop").mockRejectedValueOnce(stopError)
    try {
      await expect(cleanupCompletedRun(fixture)).rejects.toBe(stopError)
      expect(Fs.existsSync(fixture.evidenceRoot)).toBe(false)
    } finally {
      jest.restoreAllMocks()
      await originalStop()
      Fs.rmSync(fixture.evidenceRoot, { recursive: true, force: true })
    }
  })
})
