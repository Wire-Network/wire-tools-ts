import type { APIClient } from "@wireio/sdk-core"
import {
  LoadLevel,
  LoadProfile,
  type EnvelopeMetricSnapshot,
  type EnvelopeRecordSource
} from "@wireio/test-opp-stress"

import type { SwapLoadResult } from "@wireio/opp-stress-harness"

/**
 * Records every call the two direction runners receive, so the orchestration
 * can be asserted without touching a chain. Declared before `jest.mock` because
 * the factories close over it.
 */
interface RunnerCall {
  readonly direction: string
  readonly walletCount: number
  readonly swapsPerWallet: number
  readonly concurrency: number
}

const calls: RunnerCall[] = []

/** Completion order, to prove both directions were in flight together. */
const order: string[] = []

const WireDirection = "wire",
  EthereumDirection = "ethereum"

/** Build a runner result with the requested accepted/failed counts. */
function resultOf(accepted: number, failed: number): SwapLoadResult {
  return {
    submitted: accepted + failed,
    accepted: Array.from({ length: accepted }, (_unused, index) => `tx-${index}`),
    failures: Array.from({ length: failed }, (_unused, index) => ({
      index,
      identity: `id-${index}`,
      round: 0,
      reason: "rejected"
    }))
  }
}

jest.mock("@wireio/opp-stress-harness/load/loadRunner", () => {
  const actual = jest.requireActual("@wireio/opp-stress-harness/load/loadRunner")
  return {
    ...actual,
    runSwapLoad: jest.fn(async (options: Record<string, number | unknown[]>) => {
      calls.push({
        direction: WireDirection,
        walletCount: (options.wallets as unknown[]).length,
        swapsPerWallet: options.swapsPerWallet as number,
        concurrency: options.concurrency as number
      })
      // Resolve LAST so a sequential implementation would order wire after eth.
      await new Promise(resolve => setTimeout(resolve, 40))
      order.push(WireDirection)
      return resultOf(3, 1)
    })
  }
})

jest.mock("@wireio/opp-stress-harness/load/ethRunner", () => {
  const actual = jest.requireActual("@wireio/opp-stress-harness/load/ethRunner")
  return {
    ...actual,
    runEthSwapLoad: jest.fn(async (options: Record<string, number | unknown[]>) => {
      calls.push({
        direction: EthereumDirection,
        walletCount: (options.wallets as unknown[]).length,
        swapsPerWallet: options.swapsPerWallet as number,
        concurrency: options.concurrency as number
      })
      order.push(EthereumDirection)
      return resultOf(5, 2)
    })
  }
})

// Imported AFTER the mocks so duplexRunner binds the mocked runners.
const {
  DuplexObservationEndpoint,
  runDuplexBurst,
  runDuplexIteration
} = require("@wireio/opp-stress-harness")

const Profile = LoadProfile.resolve({
  level: LoadLevel.light,
  workload: { swapsPerWallet: 2, concurrency: 3 }
})

/** Wallet sets of the requested sizes; only `.length` and slicing matter here. */
function optionsWith(wireWallets: number, ethereumWallets: number) {
  return {
    profile: Profile,
    wire: {
      url: "http://depot.invalid",
      wallets: {
        version: 1,
        noncePrefix: "ld",
        funder: "funder",
        wallets: Array.from({ length: wireWallets }, (_unused, index) => ({
          index,
          account: `w${index}`,
          privateKey: "k",
          publicKey: "p"
        }))
      },
      route: { chain: "ETHEREUM", token: "ETH", reserve: "PRIMARY" },
      amounts: { wireAmount: 1n, targetAmount: 1n, toleranceBps: 500 }
    },
    ethereum: {
      url: "http://eth.invalid",
      reserveManager: "0xreserve",
      wallets: {
        version: 1,
        funder: "0xfunder",
        recipient: "recipient",
        wallets: Array.from({ length: ethereumWallets }, (_unused, index) => ({
          index,
          address: `0x${index}`,
          privateKey: "k"
        }))
      },
      route: {
        sourceToken: "ETH",
        sourceReserve: "PRIMARY",
        targetChain: "WIRE",
        targetToken: "WIRE",
        targetReserve: "PRIMARY"
      },
      amounts: { valueWei: 1n, targetAmount: 1n, toleranceBps: 500 }
    }
  }
}

/** An APIClient stub whose `envlog` rows place the head at `epoch`. */
function apiAtEpoch(epochs: readonly number[]): APIClient {
  let call = 0
  return {
    v1: {
      chain: {
        get_table_rows: async () => {
          const epoch = epochs[Math.min(call, epochs.length - 1)]
          call += 1
          // Mirrors the real `sysio.msgch::envlog` row: a depot→outpost
          // (outbound) envelope has the WIRE depot as its START endpoint.
          return {
            rows: [
              {
                epoch_index: epoch,
                endpoints: {
                  start: { kind: "CHAIN_KIND_WIRE" },
                  end: { kind: "CHAIN_KIND_EVM" }
                }
              }
            ]
          }
        }
      }
    }
  } as unknown as APIClient
}

/** A source that never yields an envelope, so sampling contributes nothing. */
const emptySource: EnvelopeRecordSource = {
  snapshot: async (): Promise<EnvelopeMetricSnapshot> => ({
    kind: "collected",
    records: [],
    candidateCount: 0,
    issues: []
  })
}

beforeEach(() => {
  calls.length = 0
  order.length = 0
})

describe("runDuplexBurst", () => {
  it("drives BOTH directions in one burst", async () => {
    // Given: a burst over 4 wallets per direction.
    const burst = await runDuplexBurst(optionsWith(10, 10), 4)

    // Then: each direction ran exactly once, and each result is carried back
    // under its own key rather than merged.
    expect(calls.map(call => call.direction).sort()).toEqual([
      EthereumDirection,
      WireDirection
    ])
    expect(burst.wire.accepted).toHaveLength(3)
    expect(burst.ethereum.accepted).toHaveLength(5)
  })

  it("runs the two directions CONCURRENTLY, not one after the other", async () => {
    // Given: a wire runner that resolves 40ms after the ethereum one.
    await runDuplexBurst(optionsWith(10, 10), 2)

    // Then: ethereum completed FIRST despite being dispatched second — proof
    // both were in flight together. Sequential dispatch would finish wire
    // first, and a loaded epochIn would never meet a loaded outbound queue.
    expect(order).toEqual([EthereumDirection, WireDirection])
  })

  it("slices both wallet sets to the requested account count", async () => {
    // Given: 10 wallets available per direction but only 3 requested.
    await runDuplexBurst(optionsWith(10, 10), 3)

    // Then: both directions drive exactly 3 — the ramp's account count is the
    // per-direction width.
    expect(calls.every(call => call.walletCount === 3)).toBe(true)
  })

  it("forwards the profile's workload to both directions", async () => {
    await runDuplexBurst(optionsWith(5, 5), 5)

    expect(
      calls.every(call => call.swapsPerWallet === 2 && call.concurrency === 3)
    ).toBe(true)
  })
})

describe("runDuplexIteration", () => {
  it("emits an observation whose byte sizes match its envelope count", async () => {
    // Given: one iteration with no envelopes sampled.
    const observation = await runDuplexIteration(
      optionsWith(8, 8),
      apiAtEpoch([4, 4]),
      emptySource,
      { iterationIndex: 0, accountCount: 4, phaseTimeoutMs: 1_000 }
    )

    // Then: the ramp's parser invariant holds — it REJECTS an observation whose
    // envelopeByteSizes length differs from envelopeCount, which would fail the
    // campaign at runtime rather than at build time.
    expect(observation.envelopeByteSizes).toHaveLength(
      observation.envelopeCount
    )
    expect(observation.kind).toBe("completed")
    expect(observation.endpoint).toBe(DuplexObservationEndpoint)
  })

  it("sums transaction outcomes across BOTH directions", async () => {
    const observation = await runDuplexIteration(
      optionsWith(8, 8),
      apiAtEpoch([4, 4]),
      emptySource,
      { iterationIndex: 1, accountCount: 4, phaseTimeoutMs: 1_000 }
    )

    // Then: 3 + 5 accepted, 1 + 2 failed — one direction's failures never hide
    // behind the other's successes.
    expect(observation.txSuccesses).toBe(8)
    expect(observation.txFailures).toBe(3)
  })

  it("records the epoch window the burst spanned", async () => {
    // Given: the head epoch advances from 7 to 9 across the burst.
    const observation = await runDuplexIteration(
      optionsWith(8, 8),
      apiAtEpoch([7, 9]),
      emptySource,
      { iterationIndex: 2, accountCount: 4, phaseTimeoutMs: 1_000 }
    )

    expect(observation.epochStart).toBe(7)
    expect(observation.epochEnd).toBe(9)
  })

  it("clamps the ramp's account count to the SMALLER wallet set", async () => {
    // Given: the ramp asks for 64 but ethereum only has 5 wallets provisioned.
    await runDuplexIteration(
      optionsWith(50, 5),
      apiAtEpoch([1, 1]),
      emptySource,
      { iterationIndex: 3, accountCount: 64, phaseTimeoutMs: 1_000 }
    )

    // Then: BOTH directions drop to 5, keeping the halves symmetric — an
    // under-provisioned side must not leave the other running wider.
    expect(calls.every(call => call.walletCount === 5)).toBe(true)
  })

  it("orders its observation timestamps", async () => {
    const observation = await runDuplexIteration(
      optionsWith(8, 8),
      apiAtEpoch([1, 1]),
      emptySource,
      { iterationIndex: 4, accountCount: 2, phaseTimeoutMs: 1_000 }
    )

    // The ramp controller rejects an unordered clock window.
    expect(observation.observationEndedAtMs).toBeGreaterThanOrEqual(
      observation.observationStartedAtMs
    )
  })
})
