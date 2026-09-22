import { SlugName, SysioContracts } from "@wireio/sdk-core"
import {
  ProtocolTiming,
  SolanaLiqSyndicationTool,
  SolanaOutpostBootstrapper
} from "@wireio/cluster-tool"

/**
 * Constants for the liq-yield flow. The topology mirrors the other OPP-ferry
 * flows so the envelope path under test is the already-validated one. Amounts
 * are liqSOL base units (9 decimals, 1:1 with the depot frame), and every
 * deadline derives from {@link ProtocolTiming} rather than a stopwatch.
 */
export namespace LIQYieldScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** Producer nodes stood up by the bootstrap. */
  export const ProducerCount = 3
  /** Batch operators ferrying OPP envelopes and cranking the yield path. */
  export const BatchOperatorCount = 3
  /** Underwriters provisioned by the bootstrap. */
  export const UnderwriterCount = 1

  /** Registered chain slug code of the Solana outpost — what `OutpostConfig.chain_code` stamps. */
  export const SolanaChainCode: bigint = BigInt(
    SlugName.from(SolanaOutpostBootstrapper.SolanaChainCodename)
  )
  /** Depot token codename the outpost's REAL liqSOL mint is registered under. */
  export const LIQTokenCodename = "LIQSOL"
  /** {@link LIQTokenCodename}'s slug code — what `synd` and `report_liq_yield` stamp. */
  export const LIQTokenCode: bigint = BigInt(SlugName.from(LIQTokenCodename))
  /** The depot frame every liq token is registered at, which its shadow symbol carries. */
  export const ShadowPrecision = 9
  /** The shadow symbol `sysio.liq` opened for liqSOL, in ABI form. */
  export const ShadowSymbol = `${ShadowPrecision},${LIQTokenCodename}`
  /** The one key field of `sysio.liq`'s symbol-keyed KV tables (`stat`, `liqpending`, `yieldidx`). */
  export const SymbolKeyField: keyof SysioContracts.SysioLiqSymbolKeyType = "symbol_code"
  /**
   * The shadow's distribution state before its first distribution: `sysio.liq`
   * creates the `yieldidx` row on the first `addyield`, and until then computes
   * against a value-initialized `yield_index` — index, pot and carry all zero.
   */
  export const InitialYieldIndex: SysioContracts.SysioLiqYieldIndexType = {
    index: "0",
    pot: 0,
    carry: 0
  }
  /**
   * `sysio.opp.common`'s `YIELD_INDEX_SCALE`: the fixed-point scale of the
   * cumulative yield index, so `owed = balance × Δindex / scale`.
   */
  export const YieldIndexScale = 1_000_000_000_000n

  /**
   * Durable handle of the flow's user keypair on Solana. Created and persisted
   * per-cluster by the airdrop step and re-loaded by every later step, so the
   * depositor, the syndicator, the linked key and the redeemed wallet are one
   * identity.
   */
  export const UserKeypairName = "liq-yield-user"
  /** The user's WIRE account — the holder the depot credits once the key is linked. */
  export const UserAccount = "liq.yielder"

  /** Lamports the user's wallet is topped up to — the deposit plus fee + tx headroom. */
  export const UserFloorLamports = 20_000_000_000n
  /** Lamports the user deposits through `sol_to_liqsol` (minted 1:1 as liqSOL). */
  export const DepositLamports = 5_000_000_000n
  /** liqSOL base units the user syndicates — a strict subset of the deposit. */
  export const SyndicateAmount = 2_000_000_000n
  /**
   * Lamports the deployer donates as bonus pool yield. A positive multiple of
   * {@link SolanaLiqSyndicationTool.BonusYieldLamportGranularity} (0.1 SOL), as
   * the program requires.
   */
  export const BonusYieldLamports =
    3n * SolanaLiqSyndicationTool.BonusYieldLamportGranularity

  /** Deadline for an attestation to cross one outpost ↔ depot hop (envelope class). */
  export const CirculationTimeoutMs = ProtocolTiming.SingleHopBudgetMs
  /** Interval between opp-debugging artifact scans and depot table reads (ms). */
  export const CirculationPollMs = 2_000
  /**
   * Deadline for the batch operators' depot cranks (`queueyield`, `tickyield`)
   * to move the yield one stage — a crank on the next epoch-state poll plus
   * irreversibility, the verification-gate class.
   */
  export const CrankTimeoutMs = ProtocolTiming.CollateralVerifyBudgetMs

  /** Ceiling on each Solana write step (one test-validator tx + confirmation). */
  export const OutpostWriteTimeoutMs = ProtocolTiming.OutpostWriteBudgetMs
  /** Ceiling on each depot write step (one transaction at irreversible finality). */
  export const DepotWriteTimeoutMs = ProtocolTiming.IrreversibilityBaseMs

  /**
   * Effective-epoch windows budgeted for `current_epoch_index` to move past the
   * pre-syndication snapshot — the shared epoch-advance liveness envelope.
   */
  export const EpochAdvanceEpochBudget = ProtocolTiming.EpochVerifyEpochCount
  /** Interval between epoch-state reads while waiting for the advance (ms). */
  export const EpochAdvancePollMs = ProtocolTiming.EpochVerifyPollIntervalMs

  /** Row page size for the depot table scans (every table read here is small). */
  export const TableQueryLimit = 100

  /**
   * Deadline for the depot to advance past the snapshotted epoch index (ms).
   *
   * @returns The deadline in milliseconds.
   */
  export function epochAdvanceDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      EpochAdvanceEpochBudget *
      ProtocolTiming.MsPerSecond
    )
  }
}
