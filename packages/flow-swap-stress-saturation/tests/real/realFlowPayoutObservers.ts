import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey } from "@solana/web3.js"
import { pollUntil } from "@wireio/test-cluster-tool"

import { Timing } from "./realFlowConstants.js"
import type { Connection } from "@solana/web3.js"
import type { ethers } from "ethers"
import type { WIREClient } from "@wireio/test-cluster-tool"
import type {
  SwapStressPayoutObservation,
  SwapStressPayoutObservationRequest,
  SwapStressPayoutObserver
} from "@wireio/test-flow-swap-stress-saturation"

type PayoutTarget = SwapStressPayoutObservationRequest["targets"][number]
type WireBalanceReader = Pick<WIREClient, "getWireBalance">
type EthereumBalanceReader = Pick<ethers.Provider, "getBalance">

/** Create a phase-1 SPL payout observer for generated recipient ATAs. */
export function splPayoutObserver(
  connection: Connection,
  mint: PublicKey
): SwapStressPayoutObserver {
  return {
    waitForPayouts: request => waitForSplPayouts(connection, mint, request)
  }
}

/** Create a phase-1 WIRE payout observer for direct depot payouts. */
export function wirePayoutObserver(
  client: WireBalanceReader
): SwapStressPayoutObserver {
  const baselines = new Map<string, bigint>()
  return {
    preparePayouts: request => prepareWireBaselines(client, baselines, request),
    waitForPayouts: request => waitForWirePayouts(client, baselines, request)
  }
}

/** Create a phase-2 ETH return observer that compares against pre-burst balances. */
export function ethereumPayoutObserver(
  provider: EthereumBalanceReader
): SwapStressPayoutObserver {
  const baselines = new Map<string, bigint>()
  return {
    preparePayouts: request =>
      prepareEthereumBaselines(provider, baselines, request),
    waitForPayouts: request =>
      waitForEthereumPayouts(provider, baselines, request)
  }
}

async function waitForSplPayouts(
  connection: Connection,
  mint: PublicKey,
  request: SwapStressPayoutObservationRequest
): Promise<SwapStressPayoutObservation> {
  let observedCount = 0
  await pollUntil(
    `${request.phase} SPL payout observed`,
    async () => {
      observedCount = await countSplTargets(connection, mint, request)
      return observedCount >= request.minimumObservedCount
    },
    Timing.PayoutDeadlineMs,
    Timing.LongPollIntervalMs
  )
  return { ...request, observedCount }
}

async function prepareWireBaselines(
  client: WireBalanceReader,
  baselines: Map<string, bigint>,
  request: SwapStressPayoutObservationRequest
): Promise<void> {
  await mapPayoutTargetsSeries(request.targets, async target => {
    baselines.set(target.address, await client.getWireBalance(target.address))
  })
}

async function waitForWirePayouts(
  client: WireBalanceReader,
  baselines: Map<string, bigint>,
  request: SwapStressPayoutObservationRequest
): Promise<SwapStressPayoutObservation> {
  let observedCount = 0
  await pollUntil(
    `${request.phase} WIRE payout observed`,
    async () => {
      observedCount = await countWireTargets(client, baselines, request)
      return observedCount >= request.minimumObservedCount
    },
    Timing.PayoutDeadlineMs,
    Timing.LongPollIntervalMs
  )
  return { ...request, observedCount }
}

async function countWireTargets(
  client: WireBalanceReader,
  baselines: Map<string, bigint>,
  request: SwapStressPayoutObservationRequest
): Promise<number> {
  const observed = await mapPayoutTargetsSeries(
    request.targets,
    async target => {
      const baseline = baselines.get(target.address)
      if (baseline === undefined)
        throw new Error(`missing WIRE payout baseline for ${target.address}`)
      return (
        (await client.getWireBalance(target.address)) >=
        baseline + request.targetAmount
      )
    }
  )
  return observed.filter(Boolean).length
}

async function countSplTargets(
  connection: Connection,
  mint: PublicKey,
  request: SwapStressPayoutObservationRequest
): Promise<number> {
  const observed = await mapPayoutTargetsSeries(request.targets, target =>
    splTargetReachedFloor(
      connection,
      mint,
      target.address,
      request.targetAmount
    )
  )
  return observed.filter(Boolean).length
}

async function splTargetReachedFloor(
  connection: Connection,
  mint: PublicKey,
  ownerAddress: string,
  targetAmount: bigint
): Promise<boolean> {
  const ata = getAssociatedTokenAddressSync(mint, new PublicKey(ownerAddress))
  try {
    return (await getAccount(connection, ata)).amount >= targetAmount
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

async function prepareEthereumBaselines(
  provider: EthereumBalanceReader,
  baselines: Map<string, bigint>,
  request: SwapStressPayoutObservationRequest
): Promise<void> {
  await mapPayoutTargetsSeries(request.targets, async target => {
    baselines.set(target.address, await provider.getBalance(target.address))
  })
}

async function waitForEthereumPayouts(
  provider: EthereumBalanceReader,
  baselines: Map<string, bigint>,
  request: SwapStressPayoutObservationRequest
): Promise<SwapStressPayoutObservation> {
  let observedCount = 0
  await pollUntil(
    `${request.phase} ETH payout observed`,
    async () => {
      observedCount = await countEthereumTargets(provider, baselines, request)
      return observedCount >= request.minimumObservedCount
    },
    Timing.PayoutDeadlineMs,
    Timing.LongPollIntervalMs
  )
  return { ...request, observedCount }
}

async function countEthereumTargets(
  provider: EthereumBalanceReader,
  baselines: Map<string, bigint>,
  request: SwapStressPayoutObservationRequest
): Promise<number> {
  const observed = await mapPayoutTargetsSeries(
    request.targets,
    async target => {
      const baseline = baselines.get(target.address)
      if (baseline === undefined)
        throw new Error(`missing ETH payout baseline for ${target.address}`)
      return (
        (await provider.getBalance(target.address)) >=
        baseline + request.targetAmount
      )
    }
  )
  return observed.filter(Boolean).length
}

function mapPayoutTargetsSeries<T>(
  targets: readonly PayoutTarget[],
  readTarget: (target: PayoutTarget) => Promise<T>
): Promise<T[]> {
  return targets.reduce<Promise<T[]>>(async (previousValues, target) => {
    const values = await previousValues
    return [...values, await readTarget(target)]
  }, Promise.resolve([]))
}
