import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the swap variance-tolerance revert flow. Amounts mirror
 * `flow-swap-with-underwriting` so both flows run against the same bootstrap
 * reserve seed; protocol waits derive from the {@link ProtocolTiming}
 * envelope. The user requests an ETHEREUM/ETH → SOLANA/SOL swap whose
 * `target_amount` is deliberately inflated past the variance tolerance, so the
 * depot's `sysio.uwrit::createuwreq` guard rejects it and refunds the source
 * deposit via SWAP_REVERT.
 */
export namespace SwapVarianceRevertScenarioConstants {
  // ── epoch / timing ─────────────────────────────────────────────────────────

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60

  /**
   * Negative-assertion wait (ms): how long the flow sleeps before checking that
   * NO UWREQ row was created. Needs to be long enough that the SwapRequest
   * envelope has reached the depot and `createuwreq` has dispatched — one epoch
   * (60s) plus the natural batch-op relay latency. Deliberately NOT an envelope
   * budget: this is a fixed sleep, so widening it adds wall clock to every run,
   * and an early check can only weaken the assertion, never flake it.
   */
  export const UwreqNegativeAssertMs = 90_000

  /**
   * Time (ms) the SWAP_REVERT outbound has to reach `DEPOT_OUTPOST_ETHEREUM`
   * AND for the ETH outpost to credit the user's refund. The request travels
   * outpost → depot, the rejection rides the depot's NEXT outbound back to the
   * outpost — a true double hop.
   */
  export const RevertDeadlineMs = ProtocolTiming.DoubleHopBudgetMs

  /** Sleep between long-running chain-state polls (ms). */
  export const LongPollIntervalMs = 3_000

  /** Buffer added on top of each poll/sleep deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000

  /**
   * Ceiling (ms) for the flow's quick read/compute/write steps — carries the
   * old jest per-test default so a hung RPC fails the step instead of the run.
   */
  export const DefaultStepTimeoutMs = 120_000

  // ── registered chain / token / reserve slug codes ──────────────────────────
  // Must match the bootstrap registry + reserve seed.

  /** Chain slug of the Ethereum outpost. */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  /** Token slug of native ETH on the Ethereum outpost. */
  export const EthereumTokenCode = SlugName.from("ETH")
  /** Chain slug of the Solana outpost. */
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Token slug of native SOL on the Solana outpost. */
  export const SolanaTokenCode = SlugName.from("SOL")
  /** Reserve slug shared by both bootstrap-seeded primary reserves. */
  export const PrimaryReserveCode = SlugName.from("PRIMARY")

  // ── collateral ─────────────────────────────────────────────────────────────

  /**
   * Per-(chain, token) minimum underwriter bond the depot config requires —
   * mirrors `flow-swap-with-underwriting` so both flows share one cluster shape
   * (no underwriting actually settles here; the guard rejects pre-UWREQ).
   */
  export const UnderwriterMinimumBond = 1_000_000_000

  // ── swap amounts ───────────────────────────────────────────────────────────

  /**
   * Source wei (1e18) escrowed into the swap — 0.05 ETH. Converted through
   * {@link WeiPerDepotUnit} so the quote math operates on the same 9-decimal
   * magnitude as the reserve seed.
   */
  export const SourceEthereumWei = 50_000_000_000_000_000n

  /** Wei per depot 9-decimal unit — converts wei (1e18) into the depot's frame. */
  export const WeiPerDepotUnit = 1_000_000_000n

  /** The swap's source amount expressed in the depot's 9-decimal frame (the quote input). */
  export const SourceDepotAmount = SourceEthereumWei / WeiPerDepotUnit

  /**
   * Maximum gas (in wei) the variance-revert tx is allowed to consume.
   * `ReserveManager.requestSwap` on anvil settles in ~120k gas at baseFee
   * ~1 gwei; 5e15 wei (0.005 ETH) is well above the ceiling and stays under any
   * realistic anvil-default balance allowance. Used to assert "user spent only
   * gas" after the refund lands.
   */
  export const MaxGasReservedWei = 5_000_000_000_000_000n

  // ── variance thresholds ────────────────────────────────────────────────────

  /** Acceptable variance in basis points (0.5%). */
  export const ToleranceBps = 50

  /**
   * Multiplier applied to the live quote when constructing the deliberately-
   * inflated `target_amount`. 2× the live quote gives a 10000 bps drift — 200×
   * past the 50 bps tolerance, so the variance branch fires unambiguously
   * regardless of small quote movement between the flow's quote read and the
   * depot's `createuwreq` dispatch.
   */
  export const RevertMultiplier = 2n

  // ── deploy artifacts ───────────────────────────────────────────────────────

  /** The Ethereum outpost contract holding `requestSwap` (deploy-artifact name). */
  export const ReserveManagerContractName = "ReserveManager"
}
