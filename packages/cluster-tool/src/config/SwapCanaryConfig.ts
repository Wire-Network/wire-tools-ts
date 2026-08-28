import { ProtocolTiming } from "../Constants.js"
import type { SwapRouteSelector } from "../tools/all/SwapRouteCatalog.js"

/** Resolved planning policy shared by fresh and connected swap-canary runs. */
export interface SwapCanaryConfig {
  /** Unioned route selectors to execute in canonical serial order. */
  readonly routes: readonly SwapRouteSelector[]
  /** Whether each route waits through its exact challenge window. */
  readonly waitForChallenge: boolean
  /** Whether this run provisions collateral instead of only verifying it. */
  readonly provisionUnderwriterCollateral: boolean
}

/** Deliberately small policy surface for the configurable swap canary. */
export namespace SwapCanaryConfig {
  /** Minimum supported protocol epoch. */
  export const EpochDurationSec = 60
  /** Source draw: 0.1 token at 18 decimals. */
  export const Source18Decimals = 100_000_000_000_000_000n
  /** Source draw: 0.1 token at 9 decimals. */
  export const Source9Decimals = 100_000_000n
  /** Source draw: 0.1 token at 6 decimals. */
  export const Source6Decimals = 100_000n
  /** Each selected non-native source receives twelve route draws. */
  export const UserFundingMultiple = 12n
  /** Shared flow-owned WIRE endpoint account. */
  export const WireUserAccount = "swapcanary"
  /** Two WIRE covers all eight from-WIRE routes plus rerun headroom. */
  export const WireUserFunding = 2_000_000_000n
  /** Live quote tolerance carried by every request. */
  export const ToleranceBps = 500
  /** Per-token bond proven by the existing non-native swap flow. */
  export const UnderwriterCollateralAmount = 15_000_000_000n
  /** Native ETH/SOL eligibility floor. */
  export const UnderwriterMinimumBond = 1_000_000_000
  /** Rows scanned in small local protocol tables. */
  export const TableRowLimit = 256

  /** One ordinary on-chain write. */
  export const WriteTimeoutMs = 60_000
  /** Poll cadence for cross-chain lifecycle gates. */
  export const PollIntervalMs = 3_000
  /** Step headroom beyond the protocol poll budget. */
  export const PollDeadlineBufferMs = 60_000
  /** Request relay or from-WIRE queue drain. */
  export const UwreqDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Underwriter race and reserve accounting. */
  export const RaceDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Remit delivery to the destination endpoint. */
  export const PayoutDeadlineMs = ProtocolTiming.DoubleHopBudgetMs
  /** Collateral relay and activation. */
  export const UnderwriterActiveDeadlineMs = ProtocolTiming.DoubleHopBudgetMs
  /** Default lock window (10m) plus one protocol hop for terminal cleanup. */
  export const ChallengeDeadlineMs = 600_000 + ProtocolTiming.SingleHopBudgetMs
}
