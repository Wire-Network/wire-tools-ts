import * as Fs from "node:fs"

import {
  OppStressRampEvidenceModeKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  runOppStressRamp
} from "@wireio/test-opp-stress"

import {
  InvalidObservationCases,
  RampConfig,
  RequiredEndpoints,
  StaleFieldCases,
  breakageObservation,
  completedObservation,
  makeEvidenceDir
} from "./stressRampContractTestSupport.js"

describe("OPP stress ramp observation contract", () => {
  it("owns callback sequencing, identity, and lifecycle timestamps", async () => {
    // Given: separate controller and observation clocks with an event log.
    const evidenceDir = makeEvidenceDir("clock"),
      events: string[] = []
    let clockReads = 0
    const clock = (): number => {
      events.push(clockReads === 0 ? "clock-start" : "clock-end")
      clockReads += 1
      return clockReads === 1 ? 1_000 : 2_000
    }

    // When: one completed observation saturates the campaign.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock,
      runIteration: async input => {
        events.push(`callback-${input.iterationIndex}-${input.accountCount}`)
        return {
          ...completedObservation(),
          saturatedEndpoints: RequiredEndpoints
        }
      }
    })

    // Then: controller fields bracket the callback and observation time remains intact.
    expect(events).toEqual(["clock-start", "callback-0-1", "clock-end"])
    expect(result.iterations[0]).toMatchObject({
      iterationIndex: 0,
      accountCount: 1,
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      observationStartedAtMs: 10n,
      observationEndedAtMs: 20n,
      kind: "saturated"
    })
    expect(result.iterations[0]).toMatchObject({
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      observationStartedAtMs: 10n,
      observationEndedAtMs: 20n
    })
    expect(Fs.readdirSync(evidenceDir)).toEqual([])
  })

  it.each(StaleFieldCases)(
    "rejects stale callback field %s before persistence",
    async (field, value) => {
      // Given: an otherwise valid callback includes one stale field.
      const evidenceDir = makeEvidenceDir(`stale-${field}`),
        invalidObservation = { ...completedObservation(), [field]: value }

      // When: the controller parses the resolved callback value.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        requiredEndpoints: RequiredEndpoints,
        config: RampConfig,
        clock: () => 1,
        runIteration: async () => invalidObservation
      })

      // Then: the typed parser returns a no-observation failure without writes.
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        breakageCategory: RampBreakageCategory.InvalidObservation
      })
      expect(Fs.readdirSync(evidenceDir)).toEqual([])
    }
  )

  it.each(InvalidObservationCases)(
    "rejects invalid observation: %s",
    async (label, observation) => {
      // Given: one malformed observation reaches the controller boundary.
      const evidenceDir = makeEvidenceDir(`invalid-${label}`)

      // When: the callback resolves to the malformed runtime shape.
      const result = await runOppStressRamp({
        evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        requiredEndpoints: RequiredEndpoints,
        config: { ...RampConfig, maxCount: 1 },
        clock: () => 1,
        runIteration: async () => observation()
      })

      // Then: the controller returns the exact invalid-observation classification.
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        breakageCategory: RampBreakageCategory.InvalidObservation
      })
      expect(Fs.readdirSync(evidenceDir)).toEqual([])
    }
  )

  it("normalizes duplicate diagnostics without mutating the callback value", async () => {
    // Given: diagnostic labels repeat in first-occurrence order.
    const evidenceDir = makeEvidenceDir("diagnostic-dedupe"),
      input = {
        ...completedObservation(),
        observedNonRequiredEndpoints: [
          "diagnostic-b",
          "diagnostic-a",
          "diagnostic-b"
        ]
      }

    // When: the observation crosses the controller boundary.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      runIteration: async () => input
    })

    // Then: campaign evidence is deduped and the raw callback array is unchanged.
    expect(input.observedNonRequiredEndpoints).toEqual([
      "diagnostic-b",
      "diagnostic-a",
      "diagnostic-b"
    ])
    expect(result.observedNonRequiredEndpoints).toEqual([
      "diagnostic-b",
      "diagnostic-a"
    ])
    expect(result.iterations[0]?.observedNonRequiredEndpoints).toEqual([
      "diagnostic-b",
      "diagnostic-a"
    ])
  })

  it("orders cumulative saturation by requirements and diagnostics by first sighting", async () => {
    // Given: two observations saturate required endpoints in reverse campaign order.
    const evidenceDir = makeEvidenceDir("campaign-order")

    // When: the controller merges both observations.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: RampConfig,
      clock: () => 1,
      runIteration: async input => ({
        ...completedObservation(),
        saturatedEndpoints:
          input.iterationIndex === 0
            ? [RunEvidenceEndpoint.OutpostEthereumDepot]
            : [RunEvidenceEndpoint.DepotOutpostEthereum],
        observedNonRequiredEndpoints:
          input.iterationIndex === 0
            ? ["diagnostic-z", "diagnostic-z"]
            : ["diagnostic-y", "diagnostic-z"]
      })
    })

    // Then: campaign arrays obey their distinct canonical ordering contracts.
    expect(result.saturatedEndpoints).toEqual(RequiredEndpoints)
    expect(result.missingEndpoints).toEqual([])
    expect(result.observedNonRequiredEndpoints).toEqual([
      "diagnostic-z",
      "diagnostic-y"
    ])
    expect(result.iterations[0]).toMatchObject({
      saturatedEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot],
      missingEndpoints: [RunEvidenceEndpoint.DepotOutpostEthereum]
    })
  })

  it("retains prior saturation when a later observation breaks", async () => {
    // Given: one endpoint saturates before a later breakage.
    const evidenceDir = makeEvidenceDir("breakage-after-prior")

    // When: the second observation reports breakage without new saturation.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: RampConfig,
      clock: () => 1,
      runIteration: async input =>
        input.iterationIndex === 0
          ? {
              ...completedObservation(),
              saturatedEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot]
            }
          : breakageObservation()
    })

    // Then: breakage wins while preserving prior endpoint evidence.
    expect(result).toMatchObject({
      status: "failed_before_saturation",
      preserveCluster: true,
      saturatedEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot],
      missingEndpoints: [RunEvidenceEndpoint.DepotOutpostEthereum]
    })
  })

  it("classifies breakage as failure even when it reports all endpoints saturated", async () => {
    // Given: a breakage observation also reports complete endpoint saturation.
    const evidenceDir = makeEvidenceDir("breakage-all")

    // When: the controller merges saturation before terminal classification.
    const result = await runOppStressRamp({
      evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
      requiredEndpoints: RequiredEndpoints,
      config: { ...RampConfig, maxCount: 1 },
      clock: () => 1,
      runIteration: async () => ({
        ...breakageObservation(),
        saturatedEndpoints: RequiredEndpoints
      })
    })

    // Then: breakage remains failed and preserved with complete ordered saturation.
    expect(result).toMatchObject({
      status: "failed_before_saturation",
      preserveCluster: true,
      saturatedEndpoints: RequiredEndpoints,
      missingEndpoints: []
    })
    expect(result.iterations[0]).toMatchObject({
      kind: "breakage",
      breakageCategory: RampBreakageCategory.Workload,
      breakageReason: "workload failed"
    })
  })
})
