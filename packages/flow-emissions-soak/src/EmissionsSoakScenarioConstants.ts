import { ProtocolTiming, type ImportSeedChainKind } from "@wireio/test-cluster-tool"

/**
 * Constants for the emissions + dclaim payout soak flow. Values carry over from
 * the previously-validated jest suite (gate-tuned 2026-06): a ~30-minute soak
 * window sampled every ≥60s, five controlled stakers seeded through
 * `sysio.dclaim::importseed` alongside a bulk synthetic load, and exact
 * per-staker claim payouts. The old suite's `process.env` tuning knobs
 * (`SOAK_DURATION_MS`, `CONTROLLED_STAKER_COUNT`, `BULK_*`, `SYNTHETIC_SEED`)
 * are preserved verbatim so local runs can shorten/grow the scenario without a
 * rebuild — the e2e gate sets none of them, so the defaults below apply there.
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
  export const SampleIntervalMs = Math.max(60_000, Math.floor(SoakDurationMs / 12))
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
  /** Bootstrapped batch operators in the bootstrap roster. */
  export const BatchOperatorCount = 3
  /** Bootstrapped underwriters in the bootstrap roster. */
  export const UnderwriterCount = 1

  // ── Controlled stakers (the test holds their ETH wallets) ─────────────────

  /** Controlled ETH stakers whose link → claim path runs end-to-end. */
  export const ControlledStakerCount = envInteger("CONTROLLED_STAKER_COUNT", 5)
  /** WIRE-account prefix for controlled stakers (`soak.sa`, `soak.sb`, …). */
  export const ControlledStakerAccountPrefix = "soak.s"
  /**
   * Anvil-mnemonic HD index base for the controlled stakers' ETH wallets —
   * deterministic derivation keeps private keys out of step inputs / the
   * report. Base 40 sits past every bootstrap operator slot, the shared swap
   * user (32), and the collateral-deposit flow's depositor (35).
   */
  export const ControlledStakerEthereumHdIndexBase = 40
  /** Per controlled staker, source-decimal (18) amount on the ETH side (100e18). */
  export const ControlledStakerSourceUnits = 100_000_000_000_000_000_000n
  /** EVM source-decimal (1e18) → WIRE-atomic (1e9) conversion divisor. */
  export const WireAtomicDivisor = 1_000_000_000n
  /**
   * Exact WIRE atomic each controlled staker is seeded with (and must receive
   * on claim): `ControlledStakerSourceUnits / 1e9`, zero dust by construction.
   */
  export const PerStakerClaimAtomic = ControlledStakerSourceUnits / WireAtomicDivisor
  /**
   * WIRE atomic pre-funded from `sysio` to `sysio.dclaim` to cover every
   * controlled-staker claim (the importseed path never calls `fundclaim`; only
   * the onreward path does — a real launch pre-funds dclaim the same way).
   */
  export const ClaimPreFundAtomic = PerStakerClaimAtomic * BigInt(ControlledStakerCount)
  /** Memo on the dclaim pre-fund transfer. */
  export const PreFundMemo = "pre-fund for importseed claim payouts"

  // ── Bulk synthetic load (exercises larger importseed batches) ─────────────

  /** Standalone ETH purchaser rows. */
  export const BulkEthereumPurchasers = envInteger("BULK_ETH_PURCHASERS", 40)
  /** Standalone ETH staker rows. */
  export const BulkEthereumStakers = envInteger("BULK_ETH_STAKERS", 40)
  /** ETH addresses appearing in BOTH purchasers and stakers (dedup path). */
  export const BulkEthereumOverlapping = envInteger("BULK_ETH_OVERLAPPING", 8)
  /** ETH stakers with non-zero `yieldClaimed` (netting path). */
  export const BulkEthereumYieldClaimed = envInteger("BULK_ETH_YIELD_CLAIMED", 8)
  /** Standalone SOL purchaser rows. */
  export const BulkSolanaPurchasers = envInteger("BULK_SOL_PURCHASERS", 20)
  /** Standalone SOL staker rows. */
  export const BulkSolanaStakers = envInteger("BULK_SOL_STAKERS", 20)
  /** Deterministic PRNG seed for the synthetic dumps (reproducible failures). */
  export const SyntheticSeed = envInteger("SYNTHETIC_SEED", 1)

  // ── importseed chain kinds (the dclaim ABI's wire-format spellings) ───────

  /** `ChainKind` wire spelling for the ETH dump (`satisfies` keeps the literal). */
  export const EthereumChain = "CHAIN_KIND_EVM" satisfies ImportSeedChainKind
  /** `ChainKind` wire spelling for the SOL dump. */
  export const SolanaChain = "CHAIN_KIND_SVM" satisfies ImportSeedChainKind

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
  /** Epochs budgeted for the `pending_claims` rows after the linkswept sweeps. */
  export const PendingClaimsEpochBudget = 3
  /** Deadline for `pending_claims` rows to land after the linkswept sweeps —
   *  depot-internal, so extension-inclusive epochs rather than a hop class. */
  export const PendingClaimsTimeoutMs =
    ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
    PendingClaimsEpochBudget *
    MsPerSecond
  /** Poll interval for the `pending_claims` wait (ms). */
  export const PendingClaimsPollIntervalMs = 2_000
  /**
   * Row limit for the `unmapped` verification query — the default 100 would
   * undercount bulk fixtures larger than one page.
   */
  export const UnmappedQueryLimit = 5000
  /** Ceiling on each single-write step (multi-finality-wait headroom). */
  export const ActionStepTimeoutMs = 120_000
  /** Buffer added on top of a poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
}
