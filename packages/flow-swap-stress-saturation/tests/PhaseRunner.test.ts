import {
  createSwapStressPhaseRunner,
  SolanaRawTransactionBytesMax
} from "@wireio/test-flow-swap-stress-saturation"

import { createDeps } from "./phaseRunnerTestSupport.js"

describe("createSwapStressPhaseRunner", () => {
  it("completes both phases for count 2 after recipient and return payouts", async () => {
    // Given: live reserve rows produce positive two-hop quotes for both directions.
    const deps = createDeps()

    // When: one iteration runs with two generated recipient pairs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: both bounded bursts ran and both payout surfaces observed delivery.
    expect(outcome.kind).toBe("completed")
    expect(
      outcome.evidence.phaseResults.reduce(
        (total, result) => total + result.txSuccesses,
        0
      )
    ).toBe(4)
    expect(
      outcome.evidence.phaseResults.reduce(
        (total, result) => total + result.txFailures,
        0
      )
    ).toBe(0)
    expect(outcome.evidence.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(deps.payoutObservers.recipient.preparedRequests).toEqual([
      {
        phase: "phase-1",
        expectedCount: 2,
        minimumObservedCount: 1,
        targetAmount: 99_970_006n,
        targets: [
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 })
        ]
      }
    ])
    expect(deps.payoutObservers.recipient.observedRequests).toEqual([
      {
        phase: "phase-1",
        expectedCount: 2,
        minimumObservedCount: 1,
        targetAmount: 99_970_006n,
        targets: [
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 })
        ]
      }
    ])
    expect(deps.payoutObservers.return.preparedRequests).toHaveLength(1)
    expect(deps.payoutObservers.return.observedRequests).toEqual([
      {
        phase: "phase-2",
        expectedCount: 2,
        minimumObservedCount: 1,
        targetAmount: 99_970_006_000_000_000n,
        targets: [
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 })
        ]
      }
    ])
  })

  it("classifies an injected phase 1 burst failure as breakage", async () => {
    // Given: the ETH burst collaborator returns one failed transaction.
    const deps = createDeps({ phase1FailureReason: "injected phase 1 revert" })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the runner stops before phase 2 and reports the burst failure.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.breakageCategory).toBe("workload")
    expect(outcome.evidence.phaseResults[0]).toMatchObject({
      phase: "phase-1",
      txSuccesses: 1,
      txFailures: 1
    })
    expect(outcome.breakageReason).toBe(
      "phase-1 burst failed: injected phase 1 revert"
    )
    expect(outcome.evidence.telemetryDegradation).toBeNull()
    expect(deps.payoutObservers.recipient.observedRequests).toEqual([])
    expect(deps.phase2Requests).toEqual([])
  })

  it("returns saturated when phase 1 metrics saturate even if payout observation fails", async () => {
    // Given: phase 1 envelope metrics saturate and the payout observer times out.
    const deps = createDeps({
      phase1MetricsSaturated: true,
      phase1PayoutFailureReason: "phase 1 payout observer timed out"
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: one Ethereum leg is not enough to pass, and payout failure is classified.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.breakageReason).toBe(
      "phase-1 payout observation failed: phase 1 payout observer timed out"
    )
    expect(outcome.evidence.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(outcome.evidence.phaseResults[0]).toMatchObject({
      phase: "phase-1",
      saturated: true,
      payout: null
    })
    expect(deps.payoutObservers.recipient.observedRequests).toHaveLength(1)
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("returns saturated from phase 1 destination evidence after payout timeout", async () => {
    // Given: request-side metrics are clean, but the Solana destination metrics saturate.
    const deps = createDeps({
      phase1PayoutFailureReason: "phase 1 payout observer timed out",
      phase1DestinationMetricsSaturated: true
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: Solana destination saturation is diagnostic-only and payout failure is classified.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.breakageReason).toBe(
      "phase-1 payout observation failed: phase 1 payout observer timed out"
    )
    expect(outcome.evidence.phaseResults[0]?.endpoint).toBe(
      "DEPOT_OUTPOST_SOLANA"
    )
    expect(outcome.evidence.phaseResults[0]?.envelopeCount).toBe(1)
    expect(
      outcome.evidence.phaseResults[0]?.envelopeByteSizes[0]
    ).toBeGreaterThan(SolanaRawTransactionBytesMax)
    expect(outcome.evidence.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(outcome.evidence.phaseResults[0]).toMatchObject({
      phase: "phase-1",
      saturated: true,
      endpoint: "DEPOT_OUTPOST_SOLANA",
      payout: null
    })
    expect(deps.payoutObservers.recipient.observedRequests).toHaveLength(1)
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("classifies a non-saturated phase 1 payout observation failure as breakage", async () => {
    // Given: the payout observer times out before any saturation is reported.
    const deps = createDeps({
      phase1PayoutFailureReason: "phase 1 payout observer timed out"
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the payout failure is surfaced as classified breakage.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.breakageReason).toBe(
      "phase-1 payout observation failed: phase 1 payout observer timed out"
    )
    expect(outcome.evidence.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(deps.payoutObservers.recipient.observedRequests).toHaveLength(1)
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("continues phase 2 evidence collection after phase 1 payout observation failure", async () => {
    // Given: phase 1 transactions succeed but the WIRE payout observer times out.
    const deps = createDeps({
      phase1PayoutFailureReason: "phase 1 payout observer timed out"
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: payout timeout remains breakage, but phase 2 still runs for all-legs evidence.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.breakageReason).toBe(
      "phase-1 payout observation failed: phase 1 payout observer timed out"
    )
    expect(outcome.evidence.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("classifies an impossible zero quote as breakage", async () => {
    // Given: the live reserve snapshot has no ETH-side chain liquidity.
    const deps = createDeps({
      reserveSnapshot: {
        ethereum: { chain: 0n, wire: 1_000_000_000_000n },
        solana: { chain: 1_000_000_000n, wire: 1_000_000_000_000n }
      }
    })

    // When: one iteration tries to compute phase 1 targets.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the typed quote error is handled as classified breakage.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.evidence.phaseResults).toEqual([])
    expect(outcome.breakageReason).toMatch(/phase-1 quote produced zero/)
  })

  it("reserves one Ethereum nonce block for the whole phase 1 burst", async () => {
    // Given: a phase 1 burst with three concurrent Ethereum submissions.
    const deps = createDeps()

    // When: one iteration runs.
    await createSwapStressPhaseRunner(deps).runIteration(3)

    // Then: nonce allocation reserves the complete burst range up front.
    expect(deps.ethereumNonceReservationCounts).toEqual([3])
  })
})
