import type { HDNodeWallet } from "ethers"
import type { Keypair } from "@solana/web3.js"
import { outputKey, type OutputKey } from "@wireio/cluster-tool"

export interface SwapEpochStressActorOutput {
  readonly actorIndex: number
  readonly ethereumWallet: HDNodeWallet
  readonly solanaKeypair: Keypair
  readonly solanaBalanceBefore: number
}

export interface SwapEpochStressRequestOutput {
  readonly actorIndex: number
  readonly transactionHash: string
  readonly blockNumber: number
}

export function stressActorOutputKey(
  actorIndex: number
): OutputKey<SwapEpochStressActorOutput> {
  return outputKey(
    `swapEpochStress.actor.${actorIndex}`,
    `swap epoch stress actor ${actorIndex}`
  )
}

export function stressRequestOutputKey(
  actorIndex: number
): OutputKey<SwapEpochStressRequestOutput> {
  return outputKey(
    `swapEpochStress.request.${actorIndex}`,
    `submitted swap epoch stress request ${actorIndex}`
  )
}

export const StressTargetAmountKey: OutputKey<bigint> = outputKey(
  "swapEpochStress.targetAmount",
  "shared ETH to SOL target amount from the pre-load live quote"
)

export const StressBaselineEpochKey: OutputKey<number> = outputKey(
  "swapEpochStress.baselineEpoch",
  "WIRE epoch immediately before concurrent swap submission"
)

export const StressBaselineUwreqIdsKey: OutputKey<number[]> = outputKey(
  "swapEpochStress.baselineUwreqIds",
  "underwrite request IDs present before concurrent swap submission"
)
