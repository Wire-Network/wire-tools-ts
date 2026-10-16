import { SysioContracts } from "@wireio/sdk-core"
import { ProtocolTiming, Steps } from "@wireio/cluster-tool"

const { SysioContractAccount, SysioContractName } = SysioContracts

/**
 * Constants for the LIQ kicker flow. The kicker's cluster configuration (budget,
 * minimum interval, per-token rate and minimum gift) is the bootstrap's
 * (`Steps.registry.Kicker*`); this flow only names the token it kicks, the
 * temporary minimum it lowers the gift to, and its deadlines. Amounts are in
 * base units (WIRE and LIQ both have 9 decimals on the depot).
 */
export namespace LIQKickerScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** Producer nodes stood up by the bootstrap. */
  export const ProducerCount = 3
  /** Batch operators — the accounts whose nodeops run the kick crank, when built with it. */
  export const BatchOperatorCount = 3
  /** Underwriters provisioned by the bootstrap: none. */
  export const UnderwriterCount = 0

  /** The LIQ token the flow kicks — `kick`'s and `setpool`'s `sym`. */
  export const LIQTokenCodename = "LIQETH"
  /** The token's LIQ/WIRE yield pool pair token (`regliqpool`'s `pair_symbol` code). */
  export const PairTokenCodename = "LIQETHP"
  /** The one key field of the symbol-keyed KV tables (`kickpools`, `stat`, `yieldidx`). */
  export const SymbolKeyField: keyof SysioContracts.SysioKickerPoolKeyType = "symbol_code"
  /** The WIRE symbol code, as balances and swap reserves carry it. */
  export const WireSymbolCode = "WIRE"

  /** ABI shadow symbol for restoring the zero-supply fixture atomically. */
  export const ShadowAssetSymbol = "9,LIQETH"

  /** `sysio.kicker`'s account. */
  export const KickerAccount = SysioContractAccount[SysioContractName.kicker]
  /** `sysio.token`'s account — the contract of the treasury draw's inline transfer. */
  export const TokenAccount = SysioContractAccount[SysioContractName.token]
  /**
   * The treasury the gift is drawn from, and the governance account that signs the
   * kick transaction's `setpool` actions (and so the kick itself).
   */
  export const TreasuryAccount = SysioContractAccount[SysioContractName.system]
  /**
   * The two T5 category buckets `sysio.system::payepoch` pushes WIRE to from the
   * treasury at every epoch advance. The treasury check sums them with the treasury,
   * so an advance landing inside the kick window moves nothing out of the sum.
   */
  export const CategoryBucketAccounts = ["sysio.ops", "sysio.gov"] as const
  /** The `sysio.token::transfer` action name the treasury draw is pushed as. */
  export const TransferActionName = "transfer"
  /** ABI identifiers used when validating transaction traces. */
  export const IssueActionName: keyof SysioContracts.SysioTokenContract["actions"] = "issue"
  /** Kicker ABI action located in irreversible crank traces. */
  export const KickActionName: keyof SysioContracts.SysioKickerContract["actions"] = "kick"
  /** Zero-supply transfer memo; names the temporary atomic fixture. */
  export const ZeroSupplyMemo = "kicker zero supply"
  /** Andon fixture diagnostics. */
  export const AndonHoldReason = "kicker hold"
  /** Andon restoration diagnostic. */
  export const AndonClearNote = "kicker hold verified"
  /** A zero-supply kick bypasses TWAP but still needs its own positive interval. */
  export const ValidationMinIntervalSec = 1
  /** Largest signed int64 ceiling; reserves all possible protocol WIRE without a transfer. */
  export const TreasuryReservationCeiling = ((1n << 63n) - 1n).toString()
  /** Positive probe budget exceeds the one-unit exhausted cap. Restored atomically to zero. */
  export const CapProbeBudget = 2
  /** UTC day divisor for asserting the cap probe executes against the exhausted day. */
  export const MsPerDay = 86_400 * ProtocolTiming.MsPerSecond

  /**
   * The minimum gift the flow lowers the pool to for the payments it checks (one base
   * unit, the smallest `setpool` accepts). The bootstrap's one-WIRE default is far above
   * what the mock pools' 10-token supply accrues between kicks, so no kick pays at it.
   */
  export const PayableMinGift = 1
  /** The pool's rate the flow keeps — the bootstrap's (and the contract's) 200 bps. */
  export const RateBps = Steps.registry.KickerRateBps
  /** The bootstrap's minimum gift the flow restores. */
  export const RestoredMinGift = Steps.registry.KickerMinGift
  /** The bootstrap's mandatory daily ceiling the flow keeps. */
  export const MaxGiftPerDay = Steps.registry.KickerMaxGiftPerDay

  /** Maximum pools examined per batch-operator poll in sysio #675. */
  export const CrankPoolsPerPoll = 10

  /** Flow observation window: the contract's 60-second floor. */
  export const TwapWindowSec = 60
  /** Crank ceiling: one base unit per UTC day, constraining it to one partial payment. */
  export const CrankDailyCap = 1
  /** Stabilization deadline: one effective epoch, with a bounded RPC tail. */
  export const SnapshotTimeoutMs =
    ProtocolTiming.effectiveEpochSec(EpochDurationSec) * ProtocolTiming.MsPerSecond

  /** Interval between depot reads while a poll waits (ms). */
  export const PollIntervalMs = 2_000
  /**
   * Deadline for the chain clock to pass `last_kick + min_interval` (ms): the
   * interval itself plus a full epoch envelope for a slow chain clock.
   */
  export const MinIntervalTimeoutMs =
    (Math.max(Steps.registry.KickerMinIntervalSec, TwapWindowSec) +
      ProtocolTiming.effectiveEpochSec(EpochDurationSec)) *
    ProtocolTiming.MsPerSecond
  /**
   * Deadline for a batch operator's crank to pay the lowered gift (ms): the crank
   * waits for the minimum interval, then pushes at most once per
   * `--batch-kick-interval-ms` (60 s default) from its 15 s poll, and the payment
   * reaches irreversibility — the depot verification-gate class.
   */
  export const CrankPaymentTimeoutMs = ProtocolTiming.CollateralVerifyBudgetMs
  /** Ceiling on each depot write step (one transaction at irreversible finality). */
  export const DepotWriteTimeoutMs =
    ProtocolTiming.IrreversibilityBaseMs + ProtocolTiming.PollDeadlineBufferMs

  /**
   * The nodeop option the batch-operator plugin registers when it carries the kick
   * crank (wire-sysio `batch_operator_plugin`, `--batch-kick-crank`). Its absence
   * from `nodeop --help` means no operator will ever push a kick on this cluster.
   */
  export const KickCrankOption = "--batch-kick-crank"
}
