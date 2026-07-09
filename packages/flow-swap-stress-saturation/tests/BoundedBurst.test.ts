import {
  allocateContiguousNonces,
  EthereumBurstDefaults,
  runEthereumSwapBurst,
  runSolanaSwapBurst
} from "@wireio/test-flow-swap-stress-saturation"
import type { EthereumBurstReserveManager } from "@wireio/test-flow-swap-stress-saturation"

import { BurstFixtures } from "./constants.js"

describe("bounded burst helpers", () => {
  it("allocates contiguous ETH nonces and captures tx failure telemetry", async () => {
    // Given: a mocked ReserveManager that fails one explicitly allocated nonce.
    const calls: number[] = []

    // When: a bounded ETH burst submits all requests.
    const result = await runEthereumSwapBurst({
      reserveManager: {
        requestSwap: async (
          ...args: Parameters<EthereumBurstReserveManager["requestSwap"]>
        ) => {
          const overrides = args[8]
          calls.push(overrides.nonce)
          expect(overrides.gasLimit).toBe(
            EthereumBurstDefaults.RequestSwapGasLimit
          )
          if (overrides.nonce === BurstFixtures.FailingNonce) {
            throw new Error("injected tx failure")
          }
          return {
            wait: async () => ({
              status: 1,
              hash: `0x${overrides.nonce}`,
              blockNumber: overrides.nonce,
              gasUsed: BigInt(overrides.nonce)
            })
          }
        }
      },
      requests: BurstFixtures.EthereumRequests,
      firstNonce: BurstFixtures.FirstNonce,
      concurrency: BurstFixtures.Concurrency
    })

    // Then: nonce allocation is contiguous and the failed tx is telemetry.
    expect(calls).toEqual(
      allocateContiguousNonces(BurstFixtures.FirstNonce, BurstFixtures.Count)
    )
    expect(result.successes).toHaveLength(BurstFixtures.Count - 1)
    expect(result.failures).toEqual([
      {
        index: BurstFixtures.FailingIndex,
        nonce: BurstFixtures.FailingNonce,
        reason: "injected tx failure"
      }
    ])
  })

  it("bounds inverse SOL/SPL route submission concurrency", async () => {
    // Given: a mocked Solana sender that measures in-flight submissions.
    let active = 0
    let maxActive = 0

    // When: SOL/SPL burst submission is bounded.
    const result = await runSolanaSwapBurst({
      requests: BurstFixtures.SolanaRequests,
      concurrency: BurstFixtures.Concurrency,
      submit: async request => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        return `sig-${request.index}`
      }
    })

    // Then: every signature is captured without exceeding the bound.
    expect(result.failures).toEqual([])
    expect(result.successes).toHaveLength(BurstFixtures.Count)
    expect(maxActive).toBeLessThanOrEqual(BurstFixtures.Concurrency)
  })
})
