import type { SyndicationChallengeSnapshot } from "./outputs/index.js"
import { SysioContracts } from "@wireio/sdk-core"
import {
  outputKey,
  ProtocolTiming,
  Steps,
  SyndicationScenario
} from "@wireio/cluster-tool"

/** Partial-release challenge amounts and runtime identities. */
export namespace SyndicationChallengeScenarioConstants {
  /** The released holder. */
  export const User = {
    account: "synd.holder",
    keypairName: "challenge-holder",
    linked: true
  }
  /** A newly created account with no code, independently funding the challenge. */
  export const Challenger = {
    account: "synd.chall",
    keypairName: "challenger",
    linked: false
  }
  /** Envelope size; twice the partial-release capacity. */
  export const Amount = 2_000_000_000n
  /** One release tranche and the fee-pot seeding syndication. */
  export const Burst = 1_000_000_000n
  /** Nonzero bounty seeded from a real earlier release's fee. */
  export const Bounty = 100_000_000n
  /** Challenge charge in addition to the hold bond. */
  export const Extra = 100_000_000n
  /** Shadow transferred to the challenger before its hold. */
  export const ChallengerFunding = 500_000_000n
  /** A distinct next message to exercise the post-burn solvency check. */
  export const ProbeAmount = 100_000_000n
  /** Fee applied to each release. */
  export const FeeBps = 1_000
  /** Rules leave the partial remainder held even as epochs advance. */
  export const Config: SysioContracts.SysioSyndSetconfigAction = {
    chain_code: SyndicationScenario.Chain,
    token_code: SyndicationScenario.Token,
    synd_fee_bps: FeeBps,
    desynd_fee_bps: 0,
    synd_burst: String(Burst),
    synd_refill: 0,
    desynd_burst: String(Burst),
    desynd_refill: 0,
    window_sec: ProtocolTiming.SyndicationChallengeWindowSec,
    bounty: String(Bounty),
    challenge_extra: String(Extra),
    min_desyndicate: Steps.registry.MinimumDesyndication
  }
  /** Fee-pot seed envelope. */
  export const SeedEpoch = outputKey<number>(
    "challenge.seedEpoch",
    "fee seed epoch"
  )
  /** Fee-pot seed request. */
  export const SeedRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("challenge.seedRequest", "fee seed request")
  /** Challenged envelope. */
  export const Epoch = outputKey<number>("challenge.epoch", "challenged epoch")
  /** Challenged request. */
  export const Request = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("challenge.request", "challenged request")
  /** Later probe envelope. */
  export const ProbeEpoch = outputKey<number>(
    "challenge.probeEpoch",
    "excess probe epoch"
  )
  /** Later probe request. */
  export const ProbeRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("challenge.probeRequest", "excess probe request")
  /** Before-intake accounting. */
  export const Before = outputKey<SyndicationChallengeSnapshot>(
    "challenge.before",
    "accounting before challenged intake"
  )
  /** Actual hold charge derived from covered and bond configuration. */
  export const Hold = outputKey<bigint>("challenge.hold", "computed hold bond")
  /** Expected refusal captured separately from its verify Step. */
  export const ClaimError = outputKey<string>(
    "challenge.claimError",
    "bonder claim refusal"
  )
}
