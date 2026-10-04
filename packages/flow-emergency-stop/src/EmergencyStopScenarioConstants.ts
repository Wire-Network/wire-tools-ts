import { SysioContracts } from "@wireio/sdk-core"
import {
  outputKey,
  type EthereumSyndicationTool,
  type SolanaLiqSyndicationTool
} from "@wireio/cluster-tool"

/** Scenario amounts and durable cross-step evidence. */
export namespace EmergencyStopScenarioConstants {
  /** Holder and donor with a linked Solana wallet. */
  export const User = {
    account: "andon.user",
    keypairName: "emergency-user",
    linked: true
  }
  /** Initial redeemable principal. */
  export const Amount = 2_000_000_000n
  /** Work deliberately held across the freeze. */
  export const HeldAmount = 1_000_000_000n
  /** Each deferred payout. */
  export const Payout = 500_000_000n
  /** Deliberate shortfall beyond measured custody slack. */
  export const Deficit = 10_000_000n
  /** Distinct later message amounts identify admitted attestations. */
  export const ProbeAmount = 100_000_000n
  /** Native wei per nine-decimal depot unit. */
  export const EthereumScale = 1_000_000_000n
  /** Funded donor and permissionless Ethereum cranker. */
  export const EthereumDonor = 32
  /** Ethereum pair token and chain. */
  export const EthereumToken = "LIQETH"
  export const EthereumChain = "ETHEREUM"
  /** Saved envelope identities. */
  export const FirstEpoch = outputKey<number>(
    "emergency.firstEpoch",
    "initial envelope"
  )
  export const HeldEpoch = outputKey<number>(
    "emergency.heldEpoch",
    "frozen work"
  )
  export const ProbeEpoch = outputKey<number>(
    "emergency.probeEpoch",
    "shortfall message"
  )
  export const RecoveryEpoch = outputKey<number>(
    "emergency.recoveryEpoch",
    "backed message"
  )
  /** Sequence produced after custody repair; admission is the barrier before clearing. */
  export const RecoverySequence = outputKey<bigint>(
    "emergency.recoverySequence",
    "post-repair Solana message"
  )
  /** Bond request identities. */
  export const FirstRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("emergency.firstRequest", "initial request")
  export const HeldRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("emergency.heldRequest", "held request")
  export const ProbeRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("emergency.probeRequest", "probe request")
  export const RecoveryRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("emergency.recoveryRequest", "recovery request")
  /** Epoch when the outpost was frozen. */
  export const FreezeEpoch = outputKey<number>(
    "emergency.freezeEpoch",
    "freeze epoch"
  )
  /** Payout evidence retained for the second on-chain attempt. */
  export const Pending =
    outputKey<SolanaLiqSyndicationTool.PendingPayoutRecord>(
      "emergency.pending",
      "stored Solana payout"
    )
  /** Balance before the frozen desyndication. */
  export const BalanceBefore = outputKey<bigint>(
    "emergency.balanceBefore",
    "holder ATA"
  )
  /** Last accepted envelope audit id when the depot cord was pulled. */
  export const EnvelopeLogId = outputKey<bigint>(
    "emergency.envelopeLogId",
    "msgch audit baseline"
  )
  /** Both buckets at the pull. */
  export const Buckets = outputKey<SysioContracts.SysioSyndBucketRowType[]>(
    "emergency.buckets",
    "bucket snapshot"
  )
  /** Measured shortfall funding, shared only by sequential lanes. */
  export const Shortfall = outputKey<bigint>(
    "emergency.shortfall",
    "custody minus outstanding plus deficit"
  )
  /** Ethereum payout identity and original native balance. */
  export const EthereumRequest = outputKey<bigint>(
    "emergency.ethereumRequest",
    "stored Ethereum payout"
  )
  /** Complete stored record retained across a refused paused payment. */
  export const EthereumPending =
    outputKey<EthereumSyndicationTool.PendingDesyndication>(
      "emergency.ethereumPending",
      "stored Ethereum payout before paused attempt"
    )
  export const EthereumBefore = outputKey<bigint>(
    "emergency.ethereumBefore",
    "native liqETH balance"
  )
  /** Last request before each redemption. */
  export const LastRequest = outputKey<bigint>(
    "emergency.lastRequest",
    "returns baseline"
  )
  /** Permanent, deliberate mismatch evidence. */
  export const Mismatches = outputKey<
    SysioContracts.SysioSyndMismatchRowType[]
  >("emergency.mismatches", "audit rows after shortfall")
  /** Expected shadow after the first burn. */
  export const Remaining = Amount - Payout
}
