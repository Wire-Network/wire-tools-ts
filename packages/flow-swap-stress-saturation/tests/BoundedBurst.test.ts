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

  it("submits contiguous ETH nonces when request indexes are non-contiguous", async () => {
    // Given: request indexes do not match their workload positions.
    const requests = [
        { ...BurstFixtures.EthereumRequests[0], index: 1 },
        { ...BurstFixtures.EthereumRequests[1], index: 3 }
      ],
      calls: number[] = []

    // When: the second sparse-index request fails after nonce submission.
    const result = await runEthereumSwapBurst({
      reserveManager: {
        requestSwap: async (
          ...args: Parameters<EthereumBurstReserveManager["requestSwap"]>
        ) => {
          const overrides = args[8]
          calls.push(overrides.nonce)
          if (overrides.nonce === BurstFixtures.FirstNonce + 1) {
            throw new Error("indexed request failure")
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
      requests,
      firstNonce: BurstFixtures.FirstNonce,
      concurrency: BurstFixtures.Concurrency
    })

    // Then: failure telemetry reports the nonce that was actually submitted.
    expect(calls).toEqual([
      BurstFixtures.FirstNonce,
      BurstFixtures.FirstNonce + 1
    ])
    expect(result.failures).toEqual([
      {
        index: 3,
        nonce: BurstFixtures.FirstNonce + 1,
        reason: "indexed request failure"
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

  it("waits for a whole SOL/SPL chunk before starting the next chunk", async () => {
    // Given: the first request in a chunk resolves before its sibling.
    const started: number[] = [],
      releaseByIndex = new Map<number, () => void>(),
      resultPromise = runSolanaSwapBurst({
        requests: BurstFixtures.SolanaRequests,
        concurrency: BurstFixtures.Concurrency,
        submit: async request => {
          started.push(request.index)
          await new Promise<void>(resolve => {
            releaseByIndex.set(request.index, resolve)
          })
          return `sig-${request.index}`
        }
      })

    await flushAsyncWork()

    // When: only the first request in the active chunk completes.
    releaseRequest(releaseByIndex, 0)
    await flushAsyncWork()

    // Then: the next chunk has not started yet.
    expect(started).toEqual([0, 1])

    // When: the whole first chunk completes.
    releaseRequest(releaseByIndex, 1)
    await flushAsyncWork()

    // Then: the next chunk starts together and the burst can complete.
    expect(started).toEqual([0, 1, 2, 3])
    releaseRequest(releaseByIndex, 2)
    releaseRequest(releaseByIndex, 3)
    await expect(resultPromise).resolves.toEqual({
      successes: BurstFixtures.SolanaRequests.map(request => ({
        index: request.index,
        nonce: null,
        id: `sig-${request.index}`,
        blockNumber: null,
        gasUsed: null
      })),
      failures: []
    })
  })
})

function releaseRequest(
  releaseByIndex: ReadonlyMap<number, () => void>,
  index: number
): void {
  const release = releaseByIndex.get(index)
  if (release === undefined) {
    throw new RangeError(`request ${index} has not started`)
  }
  release()
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}
