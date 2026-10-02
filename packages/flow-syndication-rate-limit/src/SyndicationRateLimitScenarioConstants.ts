import type { SyndicationRateLimitSnapshot } from "./outputs/index.js"
import { SysioContracts } from "@wireio/sdk-core"
import {
  outputKey,
  ProtocolTiming,
  SyndicationScenario
} from "@wireio/cluster-tool"

/** Token-bucket parameters and exact runtime snapshots. */
export namespace SyndicationRateLimitScenarioConstants {
  /** First arrival, whose item exceeds one burst. */
  export const UserA = {
    account: "synd.usera",
    keypairName: "rate-user-a",
    linked: true
  }
  /** Second arrival. */
  export const UserB = {
    account: "synd.userb",
    keypairName: "rate-user-b",
    linked: true
  }
  /** Syndication burst. */
  export const Burst = 1_000_000_000n
  /** Refill per advancing epoch. */
  export const Refill = 250_000_000n
  /** One propagation budget per epoch needed to refill an empty bucket. */
  export const FullRefillBudgetMs =
    Number(Burst / Refill) * ProtocolTiming.SingleHopBudgetMs
  /** A's arrival consumes the initial burst and first refill. */
  export const AmountA = Burst + Refill
  /** B's arrival makes the total exactly twice the burst. */
  export const AmountB = Burst - Refill
  /** Desyndication burst, less than A's released balance. */
  export const DesyndicationBurst = 500_000_000n
  /** Accepted payout within the desyndication budget. */
  export const DesyndicationAmount = 250_000_000n
  /** Pair rules belong to the scenario's own governance phase. */
  export const Config: SysioContracts.SysioSyndSetconfigAction = {
    chain_code: SyndicationScenario.Chain,
    token_code: SyndicationScenario.Token,
    synd_fee_bps: 0,
    desynd_fee_bps: 0,
    synd_burst: String(Burst),
    synd_refill: String(Refill),
    desynd_burst: String(DesyndicationBurst),
    desynd_refill: 0,
    window_sec: ProtocolTiming.SyndicationChallengeWindowSec,
    bounty: 0,
    challenge_extra: "1000000000"
  }
  /** A's envelope epoch. */
  export const Epoch = outputKey<number>("rate.epoch", "burst envelope epoch")
  /** Shared request. */
  export const Request = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("rate.request", "burst request")
  /** B's independently observed epoch. */
  export const SecondEpoch = outputKey<number>(
    "rate.secondEpoch",
    "second arrival epoch"
  )
  /** B's independently observed request. */
  export const SecondRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("rate.secondRequest", "second arrival request")
  /** Bucket after the initial burst, before the first refill. */
  export const FirstBucket = outputKey<SysioContracts.SysioSyndBucketRowType>(
    "rate.firstBucket",
    "bucket after initial release"
  )
  /** Bucket after the first refill, before the final refill. */
  export const RefillBucket = outputKey<SysioContracts.SysioSyndBucketRowType>(
    "rate.refillBucket",
    "bucket after refill release"
  )
  /** Cumulative released amount before the final refill. */
  export const RefillReleased = outputKey<bigint>(
    "rate.refillReleased",
    "released after first refill"
  )
  /** Expected refusal, verified separately. */
  export const Refusal = outputKey<string>(
    "rate.refusal",
    "desyndication refusal"
  )
  /** Redemption accounting snapshot. */
  export const BeforeDesyndication = outputKey<SyndicationRateLimitSnapshot>(
    "rate.beforeDesyndication",
    "redemption baseline"
  )
  /** Destination token balance before the accepted return. */
  export const ExternalBalanceBefore = outputKey<bigint>(
    "rate.externalBalanceBefore",
    "external redemption baseline"
  )
}
