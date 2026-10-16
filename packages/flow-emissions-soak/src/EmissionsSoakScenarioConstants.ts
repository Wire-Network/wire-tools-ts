import { EthereumPreLaunchSteps, ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the emissions + dclaim payout soak flow: a ~30-minute soak
 * window sampled every ≥60s, and exact claim payouts for the pre-launch buyers
 * whose pretokens the ladder import seeded into `sysio.dclaim`. The
 * `SOAK_DURATION_MS` / `EPOCH_DURATION_SEC` env knobs let local runs shorten or
 * grow the soak without a rebuild — the e2e gate sets neither, so the defaults
 * below apply there.
 */
export namespace EmissionsSoakScenarioConstants {
  /** Parse an integer env override, falling back to the gate-tuned default. */
  function envInteger(name: string, fallback: number): number {
    return Number(process.env[name] ?? fallback)
  }

  // ── Soak window ────────────────────────────────────────────────────────────

  /** Wall-clock soak duration (ms). Default 30 min ⇒ ~30 epochs at 60s epochs. */
  export const SoakDurationMs = envInteger("SOAK_DURATION_MS", 30 * 60 * 1000)
  /**
   * Interval between t5state samples (ms) — the old suite's
   * `max(60s, soak/12)` so short local windows still collect ≥1 sample and the
   * default window samples roughly per epoch.
   */
  export const SampleIntervalMs = Math.max(
    60_000,
    Math.floor(SoakDurationMs / 12)
  )
  /**
   * Margin added to the soak window for the StabilityLoop step/phase timeout —
   * the old suite's per-test budget was `SOAK_DURATION_MS + 30 min`.
   */
  export const SoakTimeoutMarginMs = 30 * 60 * 1000

  // ── Cluster topology (the old suite's `beforeAll` FlowTestContext options) ──

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = envInteger("EPOCH_DURATION_SEC", 60)
  /** Producers in the bootstrap roster. */
  export const ProducerCount = 3
  /**
   * Bootstrapped batch operators in the bootstrap roster — the mainnet roster
   * size, so the soak exercises the full 3-group × 7-member sliding window (and
   * its per-epoch rotation) over the whole soak window rather than the
   * degenerate 3 × 1 shape. Must stay ODD and divisible by 3.
   */
  export const BatchOperatorCount = 21
  /** Bootstrapped underwriters in the bootstrap roster. */
  export const UnderwriterCount = 0

  // ── Claimants (the ladder's pre-launch buyers; the harness holds their keys) ──

  /** One claimant: a pre-launch actor and the WIRE account it links its Ethereum key to. */
  export interface Claimant {
    /** The pre-launch actor (`EthereumPreLaunchSteps`): stakers first, then buyers. */
    readonly actorIndex: number
    /** The WIRE account the actor's dclaim seed sweeps into and claims from. */
    readonly wireAccount: string
  }

  /** WIRE-account prefix for claimants (`soak.sa`, `soak.sb`, …). */
  export const ClaimantAccountPrefix = "soak.s"
  /** Sysio-name-safe letters for claimant account suffixes. */
  export const ClaimantAccountSuffixes = "abcdefghijklmnopqrstuvwxyz"
  /** Memo on the dclaim pre-fund transfer. */
  export const PreFundMemo = "pre-fund for the pre-launch buyers' claim payouts"

  /**
   * The claimants: every pre-launch buyer. Their pretoken purchases are what the
   * ladder import seeded into `sysio.dclaim`, so each has a credit to claim.
   */
  export function claimants(): Claimant[] {
    return Array.from({ length: EthereumPreLaunchSteps.BuyerCount }, (_, index) => ({
      actorIndex: EthereumPreLaunchSteps.buyerActorIndex(index),
      wireAccount: `${ClaimantAccountPrefix}${ClaimantAccountSuffixes[index]}`
    }))
  }

  // ── Expected bootstrap emission splits (pinned — alerts on default drift) ──

  /** Expected `emitcfg.compute_bps` seeded by the bootstrap. */
  export const ExpectedComputeBps = 4000
  /** Expected `emitcfg.capex_bps` seeded by the bootstrap. */
  export const ExpectedCapexBps = 2000
  /** Expected `emitcfg.governance_bps` seeded by the bootstrap. */
  export const ExpectedGovernanceBps = 1000

  // ── Poll / query budgets ───────────────────────────────────────────────────

  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000
  /** Epochs budgeted for `pending_claims` after AuthX performs its inline sweeps. */
  export const PendingClaimsEpochBudget = 3
  /** Deadline for `pending_claims` rows to land after the inline AuthX sweeps —
   *  depot-internal, so extension-inclusive epochs rather than a hop class. */
  export const PendingClaimsTimeoutMs =
    ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
    PendingClaimsEpochBudget *
    MsPerSecond
  /** Poll interval for the `pending_claims` wait (ms). */
  export const PendingClaimsPollIntervalMs = 2_000
  /** Row limit for the `unmapped` verification query: every seeded row on one page. */
  export const UnmappedQueryLimit = 5000
  /** Ceiling on each single-write step (multi-finality-wait headroom). */
  export const ActionStepTimeoutMs = 120_000
  /** Buffer added on top of a poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
}
