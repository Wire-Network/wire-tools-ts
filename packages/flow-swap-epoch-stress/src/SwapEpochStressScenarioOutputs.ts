import type { HDNodeWallet } from "ethers"
import type { Keypair } from "@solana/web3.js"
import { outputKey, type OutputKey } from "@wireio/cluster-tool"

/** Provisioned source wallet and destination account for one stress actor. */
export interface SwapEpochStressActorOutput {
  readonly actorIndex: number
  readonly ethereumWallet: HDNodeWallet
  readonly solanaKeypair: Keypair
  readonly solanaBalanceBefore: number
}

/** Confirmed Ethereum request transaction produced by one stress actor. */
export interface SwapEpochStressRequestOutput {
  readonly actorIndex: number
  readonly transactionHash: string
  readonly blockNumber: number
}

/** Retention-safe WIRE request state captured before destination payout waits. */
export interface SwapEpochStressRequestSnapshotOutput {
  readonly requestIds: number[]
  readonly requestStatuses: string[]
  readonly ingestedCount: number
  readonly confirmedCount: number
}

/**
 * Build the typed output key for one provisioned stress actor.
 *
 * @param actorIndex Zero-based actor index.
 * @returns Actor-specific output key.
 */
export function stressActorOutputKey(
  actorIndex: number
): OutputKey<SwapEpochStressActorOutput> {
  return outputKey(
    `swapEpochStress.actor.${actorIndex}`,
    `swap epoch stress actor ${actorIndex}`
  )
}

/**
 * Build the typed output key for one submitted swap request.
 *
 * @param actorIndex Zero-based actor index.
 * @returns Request-specific output key.
 */
export function stressRequestOutputKey(
  actorIndex: number
): OutputKey<SwapEpochStressRequestOutput> {
  return outputKey(
    `swapEpochStress.request.${actorIndex}`,
    `submitted swap epoch stress request ${actorIndex}`
  )
}

/** Shared ETH-to-SOL target amount computed from the live reserve quote. */
export const StressTargetAmountKey: OutputKey<bigint> = outputKey(
  "swapEpochStress.targetAmount",
  "shared ETH to SOL target amount from the pre-load live quote"
)

/** WIRE epoch observed immediately before concurrent request submission. */
export const StressBaselineEpochKey: OutputKey<number> = outputKey(
  "swapEpochStress.baselineEpoch",
  "WIRE epoch immediately before concurrent swap submission"
)

/** UWREQ identifiers that existed before the flow applied its load. */
export const StressBaselineUwreqIdsKey: OutputKey<number[]> = outputKey(
  "swapEpochStress.baselineUwreqIds",
  "underwrite request IDs present before concurrent swap submission"
)

/** Stress UWREQ lifecycle snapshot captured before the ten-epoch retention window. */
export const StressRequestSnapshotKey: OutputKey<SwapEpochStressRequestSnapshotOutput> =
  outputKey(
    "swapEpochStress.requestSnapshot",
    "retention-safe stress UWREQ identifiers, statuses, and counts"
  )
