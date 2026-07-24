import {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceSaturationStrategy,
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  arrayField,
  createVerifierFixture,
  objectField,
  readVerifierJson,
  recordValue,
  refreshVerifierRecordHash,
  writeVerifierJson,
  type VerifierPhaseSpec
} from "./runEvidenceVerifierTestSupport.js"

describe("run evidence verifier metric recomputation", () => {
  it.each([
    [RunEvidenceSaturationStrategy.ByteThreshold, 62_258, 0, false],
    [RunEvidenceSaturationStrategy.ByteThreshold, 62_259, 0, true],
    [RunEvidenceSaturationStrategy.Rollover, 1_000, 0, false],
    [RunEvidenceSaturationStrategy.Rollover, 1_000, 1, true]
  ])(
    "recomputes %s at bytes %i and envelope index %i",
    (strategy, byteSize, epochEnvelopeIndex, saturated) => {
      // Given: exact raw bytes at a strategy boundary.
      const fixture = createVerifierFixture({
        lifecycle: saturated
          ? RunEvidenceLifecycle.Saturated
          : RunEvidenceLifecycle.Incomplete,
        phases: [
          phase(
            RunEvidenceEndpoint.DepotOutpostEthereum,
            strategy,
            byteSize,
            epochEnvelopeIndex
          )
        ]
      })
      try {
        // When: the verifier classifies the generated envelope bytes.
        const report = verifyRunEvidence(fixture.runDirectory)

        // Then: the strategy uses the exact floor and rollover semantics.
        expect(report.issues).toEqual([])
        expect(report.recomputedIterations[0]?.phases[0]?.saturated).toBe(
          saturated
        )
      } finally {
        fixture.cleanup()
      }
    }
  )

  it.each([
    [1_232, false],
    [1_233, true]
  ])("recomputes Solana oversize at %i bytes", (byteSize, oversized) => {
    // Given: valid Solana evidence on one side of the raw transaction cap.
    const fixture = createVerifierFixture({
      lifecycle: RunEvidenceLifecycle.Incomplete,
      requiredEndpoints: [RunEvidenceEndpoint.DepotOutpostSolana],
      phases: [
        phase(
          RunEvidenceEndpoint.DepotOutpostSolana,
          RunEvidenceSaturationStrategy.ByteThreshold,
          byteSize,
          0
        )
      ]
    })
    try {
      // When: raw artifact metrics are recomputed.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: only bytes strictly above 1232 are diagnostic oversize.
      expect(report.issues).toEqual([])
      expect(report.recomputedIterations[0]?.phases[0]?.solanaOversized).toBe(
        oversized
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects hash-consistent forged saturation backed by valid small bytes", () => {
    // Given: canonical below-threshold evidence with every recorded verdict forged saturated.
    const fixture = createVerifierFixture({
      lifecycle: RunEvidenceLifecycle.Incomplete,
      phases: [
        phase(
          RunEvidenceEndpoint.DepotOutpostEthereum,
          RunEvidenceSaturationStrategy.ByteThreshold,
          62_258,
          0
        )
      ]
    })
    try {
      forgeSaturatedClaims(fixture.runDirectory)

      // When: all record hashes agree with the forged claims.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: raw bytes still prevent a verified saturated verdict.
      expect(report.valid).toBe(false)
      expect(report.verifiedSaturated).toBe(false)
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.MetricMismatch
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("verifies independent saturation for every required endpoint", () => {
    // Given: one valid threshold phase for each required Ethereum direction.
    const endpoints = [
        RunEvidenceEndpoint.DepotOutpostEthereum,
        RunEvidenceEndpoint.OutpostEthereumDepot
      ],
      fixture = createVerifierFixture({
        lifecycle: RunEvidenceLifecycle.Saturated,
        requiredEndpoints: endpoints,
        phases: endpoints.map(endpoint =>
          phase(
            endpoint,
            RunEvidenceSaturationStrategy.ByteThreshold,
            62_259,
            0
          )
        )
      })
    try {
      // When: the endpoint campaign is recomputed from both raw pairs.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: both required partitions have byte-backed supporting phases.
      expect(report.issues).toEqual([])
      expect(report.recomputedEndpoints).toEqual([
        {
          endpoint: endpoints[0],
          saturated: true,
          supportingPhases: ["0:phase-0"]
        },
        {
          endpoint: endpoints[1],
          saturated: true,
          supportingPhases: ["0:phase-1"]
        }
      ])
    } finally {
      fixture.cleanup()
    }
  })
})

function phase(
  endpoint: RunEvidenceEndpoint,
  strategy: RunEvidenceSaturationStrategy,
  byteSize: number,
  epochEnvelopeIndex: number
): VerifierPhaseSpec {
  return { endpoint, strategy, byteSize, epochEnvelopeIndex }
}

function forgeSaturatedClaims(runDirectory: string): void {
  const iteration = readVerifierJson(
      runDirectory,
      `${RunEvidencePath.Iterations}/000000.json`
    ),
    phaseRecord = recordValue(arrayField(iteration, "phases")[0]),
    metrics = objectField(phaseRecord, "metrics"),
    endpointResult = recordValue(arrayField(iteration, "endpointResults")[0])
  metrics["saturated"] = true
  iteration["outcome"] = "saturated"
  iteration["saturatedEndpoints"] = [RunEvidenceEndpoint.DepotOutpostEthereum]
  iteration["missingEndpoints"] = []
  endpointResult["saturated"] = true
  writeVerifierJson(
    runDirectory,
    `${RunEvidencePath.Iterations}/000000.json`,
    iteration
  )
  refreshVerifierRecordHash(
    runDirectory,
    `${RunEvidencePath.Iterations}/000000.json`
  )
  const manifestAfterIteration = readVerifierJson(
      runDirectory,
      RunEvidencePath.Manifest
    ),
    iterationRefs = arrayField(
      objectField(manifestAfterIteration, "records"),
      "iterations"
    ),
    terminal = readVerifierJson(runDirectory, RunEvidencePath.Terminal),
    terminalResult = recordValue(arrayField(terminal, "endpointResults")[0])
  terminal["lifecycle"] = "saturated"
  terminal["preserveCluster"] = false
  terminal["saturatedEndpoints"] = [RunEvidenceEndpoint.DepotOutpostEthereum]
  terminal["missingEndpoints"] = []
  terminal["iterationRefs"] = iterationRefs
  terminalResult["saturated"] = true
  writeVerifierJson(runDirectory, RunEvidencePath.Terminal, terminal)
  refreshVerifierRecordHash(runDirectory, RunEvidencePath.Terminal)
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest)
  manifest["lifecycle"] = "saturated"
  manifest["preserveCluster"] = false
  manifest["saturatedEndpoints"] = [RunEvidenceEndpoint.DepotOutpostEthereum]
  manifest["missingEndpoints"] = []
  writeVerifierJson(runDirectory, RunEvidencePath.Manifest, manifest)
}
