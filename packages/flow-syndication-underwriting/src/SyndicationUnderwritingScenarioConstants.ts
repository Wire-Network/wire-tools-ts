import type { SyndicationUnderwritingSnapshot } from "./outputs/index.js"
import { SysioContracts } from "@wireio/sdk-core"
import {
  outputKey,
  ProtocolTiming,
  Steps,
  SyndicationScenario
} from "@wireio/cluster-tool"

/** Amounts and typed cross-step state for the underwriting flow. */
export namespace SyndicationUnderwritingScenarioConstants {
  /** Linked syndicator. */
  export const User = {
    account: "synd.user",
    keypairName: "syndication-user",
    linked: true
  }
  /** Recipient linked only after release parks its shadow. */
  export const Unlinked = {
    account: "synd.parked",
    keypairName: "syndication-parked",
    linked: false
  }
  /** Deliberately not an increment multiple, exercising covered rounding. */
  export const Amount = 2_000_000_001n
  /** The first request's covered amount: {@link Amount} rounded up to the bond increment. */
  export const FirstCovered =
    ((Amount + SyndicationScenario.Increment - 1n) /
      SyndicationScenario.Increment) *
    SyndicationScenario.Increment
  /**
   * The underwriter daemon's LIQSOL exposure cap: exactly the first request's
   * covered amount, so it bonds the second request only once the first bond is
   * paid back. The third is syndicated after the second settles.
   */
  export const UnderwriterExposureCap =
    SyndicationScenario.quantity(FirstCovered)
  /** Later syndication amount. */
  export const LaterAmount = 500_000_000n
  /** Nonzero fee rate. */
  export const FeeBps = 100
  /** Pair-specific governance rules, restored at the end. */
  export const Config: SysioContracts.SysioSyndSetconfigAction = {
    chain_code: SyndicationScenario.Chain,
    token_code: SyndicationScenario.Token,
    synd_fee_bps: FeeBps,
    desynd_fee_bps: 0,
    synd_burst: "100000000000",
    synd_refill: "100000000000",
    desynd_burst: "100000000000",
    desynd_refill: "100000000000",
    window_sec: ProtocolTiming.SyndicationChallengeWindowSec,
    bounty: 0,
    challenge_extra: "1000000000",
    min_desyndicate: Steps.registry.MinimumDesyndication
  }
  /** Initial ledger and custody balances. */
  export const Before = outputKey<SyndicationUnderwritingSnapshot>(
    "underwriting.before",
    "balances before intake"
  )
  /** First envelope epoch. */
  export const FirstEpoch = outputKey<number>(
    "underwriting.firstEpoch",
    "first consensus epoch"
  )
  /** First request id. */
  export const FirstRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("underwriting.firstRequest", "first request")
  /** Second envelope epoch. */
  export const SecondEpoch = outputKey<number>(
    "underwriting.secondEpoch",
    "later consensus epoch"
  )
  /** Second request id. */
  export const SecondRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("underwriting.secondRequest", "later request")
  /** Parked recipient's envelope epoch. */
  export const ParkedEpoch = outputKey<number>(
    "underwriting.parkedEpoch",
    "unlinked consensus epoch"
  )
  /** Parked recipient's request id. */
  export const ParkedRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("underwriting.parkedRequest", "unlinked request")
}
