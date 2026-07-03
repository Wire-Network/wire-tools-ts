import { SlugName } from "@wireio/sdk-core"
import { outputKey, type Books, type OutputKey } from "@wireio/test-cluster-tool"

/**
 * Constants for the bidirectional swap-with-underwriting flow. Timing budgets,
 * swap amounts, and the variance tolerance carry over from the previously-
 * validated jest run (`tests/constants.ts`, tuned against the real cluster):
 * every deadline scales from the 60s minimum-epoch rule per
 * `epoch-stall-is-fatal.md`, and each direction's source amount draws 1% of the
 * bootstrap reserve seed.
 */
export namespace SwapWithUnderwritingScenarioConstants {
  // ── Timing ────────────────────────────────────────────────────────────────

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** Time the depot has to insert a UWREQ row after the source outpost emits SWAP_REQUEST. */
  export const UwreqDeadlineMs = 180_000
  /** Time for the underwriter race to resolve (CONFIRMED status). */
  export const RaceDeadlineMs = 240_000
  /** Time for the SWAP_REMIT to land on the destination outpost AND credit the user. */
  export const RemitDeadlineMs = 480_000
  /** Sleep between long-running chain-state polls. */
  export const LongPollIntervalMs = 3_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** Hard ceiling on each on-chain request write step (submit + confirm). */
  export const RequestStepTimeoutMs = 60_000
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000

  /**
   * Epochs budgeted for the underwriter collateral DEPOSIT_REQUESTs to relay to
   * the depot and flip `uwrit.a` ACTIVE. The old jest flow polled this gate with
   * `UwreqDeadlineMs` (180s) because its bootstrap had already submitted the
   * deposits minutes earlier (old Phase 11d); this flow submits them as its own
   * first scenario phase, so the gate budgets the full deposit→credit relay —
   * the same 9-epoch budget `flow-operator-collateral-deposit` validated green.
   */
  export const UnderwriterActiveEpochBudget = 9

  /** Deadline for the underwriter deposit relay + ACTIVE eligibility flip. */
  export function underwriterActiveDeadlineMs(): number {
    return EpochDurationSec * UnderwriterActiveEpochBudget * MsPerSecond
  }

  // ── Registry slugs (must match the bootstrap registry seed) ──────────────

  /** Registered chain slug codes. */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug codes. */
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")
  /** The bootstrap-seeded reserve slug both directions swap through. */
  export const PrimaryReserveCode = SlugName.from("PRIMARY")

  /** Ethereum outpost contract the swap user calls `requestSwap` on. */
  export const ReserveManagerContractName = "ReserveManager"

  // ── Reserves & amounts ────────────────────────────────────────────────────

  /**
   * `chain_amount` + `wire_amount` the bootstrap seeds into each PRIMARY
   * reserve (`RegistrySteps.seedRegistry`, depot 9-decimal frame). The source
   * amounts below draw 1% of it so the constant-product quote stays deep in
   * the linear region.
   */
  export const InitialReserveAmount = 10_000_000_000n

  /**
   * Wei per depot base unit: a token's depot precision is
   * `min(nativeDecimals, 9)`, and native ETH is 18-decimal — above the cap —
   * so the ETH outpost divides wei by 1e9 inbound (`PrecisionLib.toDepot`)
   * and multiplies by 1e9 when settling a SWAP_REMIT.
   */
  export const WeiPerDepotUnit = 10n ** 9n

  /**
   * Phase A source: 0.1 ETH = 1e17 wei. The outpost converts to 1e8 depot
   * 9-decimal units — 1% of {@link InitialReserveAmount}.
   */
  export const SourceEthereumWei = 100_000_000_000_000_000n

  /**
   * Phase B source: 0.1 SOL = 1e8 lamports. Lamports are already 9-decimal,
   * so this passes through as 1e8 depot units — 1% of
   * {@link InitialReserveAmount}.
   */
  export const SourceSolanaLamports = 100_000_000n

  /**
   * Variance tolerance the user attaches to each SwapRequest — 50 basis
   * points (0.5%). Generous so quote drift between request-build and
   * depot-resolve (including the wire-leg fee skim) doesn't trip the depot's
   * variance check during a long E2E run.
   */
  export const ToleranceBps = 50

  /**
   * Per-(chain, token) minimum bond configured via
   * `requiredUnderwriterCollateral` → `sysio.opreg::setconfig(req_uw_collat)`.
   * The depot's `meets_role_min` rejects non-bootstrapped underwriters when the
   * config is empty, and `uwrit.a` must flip ACTIVE for the race to land any
   * commits. Matches `WireUnderwriterTool.DefaultAmount` (the per-chain deposit
   * this flow's UnderwriterCollateral phase bonds), so `reevaluate_eligibility`
   * flips status=ACTIVE once both DEPOSIT_REQUESTs credit.
   */
  export const UnderwriterMinimumBond = 1_000_000_000

  // ── Cross-step output keys (values ride `ctx.outputs`) ───────────────────

  /** Phase A lamport-scale target amount computed by the swapquote step. */
  export const PhaseATargetAmountKey: OutputKey<bigint> = outputKey(
    "swapWithUnderwriting.phaseATargetAmount",
    "Phase A target amount (lamports) from the ETH→SOL swapquote"
  )

  /** Phase A pre-request source + destination reserve books. */
  export const PhaseABooksBeforeKey: OutputKey<Books> = outputKey(
    "swapWithUnderwriting.phaseABooksBefore",
    "Phase A pre-request (src=ETH, dst=SOL) reserve books"
  )

  /** Phase A pre-request swap-user SOL balance (lamports). */
  export const PhaseASolanaBalanceBeforeKey: OutputKey<number> = outputKey(
    "swapWithUnderwriting.phaseASolanaBalanceBefore",
    "Phase A pre-request swap-user SOL balance (lamports)"
  )

  /** Phase B depot-frame (9-decimal) target amount — rides the OPP envelope. */
  export const PhaseBTargetAmountDepotKey: OutputKey<bigint> = outputKey(
    "swapWithUnderwriting.phaseBTargetAmountDepot",
    "Phase B target amount (depot 9-decimal units) from the SOL→ETH swapquote"
  )

  /** Phase B pre-request swap-user ETH balance (wei). */
  export const PhaseBEthereumBalanceBeforeKey: OutputKey<bigint> = outputKey(
    "swapWithUnderwriting.phaseBEthereumBalanceBefore",
    "Phase B pre-request swap-user ETH balance (wei)"
  )
}
