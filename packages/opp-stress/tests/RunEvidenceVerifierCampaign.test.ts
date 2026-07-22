import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  serializeRunEvidenceJson,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { verifierFixtureSha256 } from "./runEvidenceVerifierArtifactFixture.js"
import {
  arrayField,
  createVerifierFixture,
  objectField,
  readVerifierJson,
  recordValue,
  refreshVerifierRecordHash,
  writeVerifierJson
} from "./runEvidenceVerifierTestSupport.js"

describe("run evidence verifier campaign consistency", () => {
  it("rejects a forged required endpoint", () => {
    // Given: manifest success names a different required endpoint than its records and bytes.
    const fixture = createVerifierFixture()
    try {
      const manifest = readVerifierJson(
        fixture.runDirectory,
        RunEvidencePath.Manifest
      )
      manifest["requiredEndpoints"] = [RunEvidenceEndpoint.OutpostEthereumDepot]
      manifest["saturatedEndpoints"] = [
        RunEvidenceEndpoint.OutpostEthereumDepot
      ]
      manifest["missingEndpoints"] = []
      writeVerifierJson(
        fixture.runDirectory,
        RunEvidencePath.Manifest,
        manifest
      )

      // When: required partitions are recomputed across every record.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: manifest-only endpoint authority cannot create success.
      const codes = report.issues.map(issue => issue.code)
      expect(codes).toContain(
        RunEvidenceVerificationIssueCode.ReferenceMismatch
      )
      expect(report.verifiedSaturated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects iterations after the first all-endpoint saturation", () => {
    // Given: a second contiguous clean iteration is appended after campaign success.
    const fixture = createVerifierFixture()
    try {
      appendPostSaturationIteration(fixture.runDirectory)

      // When: the campaign stop point is independently derived.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: later records contradict the first all-endpoint saturation barrier.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.CampaignMismatch
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects lifecycle timestamps that move backward", () => {
    // Given: iteration starts before successful setup ended.
    const fixture = createVerifierFixture()
    try {
      const path = `${RunEvidencePath.Iterations}/000000.json`,
        iteration = readVerifierJson(fixture.runDirectory, path)
      iteration["startedAtMs"] = "99"
      writeVerifierJson(fixture.runDirectory, path, iteration)
      refreshVerifierRecordHash(fixture.runDirectory, path)
      refreshTerminalRefs(fixture.runDirectory)

      // When: record chronology is checked independently of phase windows.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: backward controller time invalidates the lifecycle.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.LifecycleMismatch
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects a filesystem iteration index gap", () => {
    // Given: iteration zero is renamed to iteration one after publication.
    const fixture = createVerifierFixture()
    try {
      Fs.renameSync(
        Path.join(
          fixture.runDirectory,
          RunEvidencePath.Iterations,
          "000000.json"
        ),
        Path.join(
          fixture.runDirectory,
          RunEvidencePath.Iterations,
          "000001.json"
        )
      )

      // When: manifest refs and directory enumeration are compared.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: the missing zero and undeclared one are both evidence defects.
      const codes = report.issues.map(issue => issue.code)
      expect(codes).toContain(RunEvidenceVerificationIssueCode.MissingEntry)
      expect(codes).toContain(RunEvidenceVerificationIssueCode.ExtraEntry)
    } finally {
      fixture.cleanup()
    }
  })

  it("verifies multiplicative ramp progression to exact max", () => {
    // Given: below-threshold iterations progress from three accounts to max six.
    const fixture = createVerifierFixture({
      lifecycle: RunEvidenceLifecycle.Incomplete,
      initialCount: 3,
      maxCount: 6,
      accountCount: 3
    })
    try {
      appendSecondIteration(fixture.runDirectory, 6, "phase-at-max")

      // When: account progression and final max are independently recomputed.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: the valid campaign is verified non-success with two iterations.
      expect(report.issues).toEqual([])
      expect(
        report.recomputedIterations.map(item => item.accountCount)
      ).toEqual([3, 6])
    } finally {
      fixture.cleanup()
    }
  })
})

function appendPostSaturationIteration(runDirectory: string): void {
  appendSecondIteration(runDirectory, 3, "phase-after-saturation")
}

function appendSecondIteration(
  runDirectory: string,
  accountCount: number,
  label: string
): void {
  const first = readVerifierJson(
      runDirectory,
      `${RunEvidencePath.Iterations}/000000.json`
    ),
    phases = arrayField(first, "phases")
  first["iterationIndex"] = 1
  first["accountCount"] = accountCount
  first["startedAtMs"] = "105"
  first["endedAtMs"] = "106"
  recordValue(phases[0])["label"] = label
  const path = `${RunEvidencePath.Iterations}/000001.json`,
    bytes = serializeRunEvidenceJson(first),
    ref = { path, sha256: verifierFixtureSha256(bytes) }
  Fs.writeFileSync(Path.join(runDirectory, path), bytes)
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    records = objectField(manifest, "records"),
    refs = arrayField(records, "iterations")
  refs.push(ref)
  writeVerifierJson(runDirectory, RunEvidencePath.Manifest, manifest)
  refreshTerminalRefs(runDirectory)
}

function refreshTerminalRefs(runDirectory: string): void {
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    refs = arrayField(objectField(manifest, "records"), "iterations"),
    terminal = readVerifierJson(runDirectory, RunEvidencePath.Terminal)
  terminal["iterationRefs"] = refs
  writeVerifierJson(runDirectory, RunEvidencePath.Terminal, terminal)
  refreshVerifierRecordHash(runDirectory, RunEvidencePath.Terminal)
}
