import { SlugName } from "@wireio/sdk-core"
import {
  Constants as HarnessConstants,
  ProtocolTiming,
  SolanaLiqSyndicationTool
} from "@wireio/cluster-tool"

/**
 * Constants for the liq-syndication flow. The topology mirrors the other
 * OPP-ferry flows so the envelope path under test is the already-validated one.
 * Amounts are lamports / liqSOL base units (9 decimals, 1:1 with the depot
 * frame), and every deadline derives from {@link ProtocolTiming} rather than a
 * stopwatch.
 */
export namespace LIQSyndicationScenarioConstants {
  /** Consensus epoch duration (s) of every outpost chain. */
  export const EpochDurationSec = 60
  /** Producer nodes stood up by the bootstrap. */
  export const ProducerCount = 3
  /** Batch operators ferrying OPP envelopes (the group that must relay the attestations). */
  export const BatchOperatorCount = 3
  /** Underwriters provisioned by the bootstrap. */
  export const UnderwriterCount = 0

  /** Registered chain slug code of the Solana outpost — what `OutpostConfig.chain_code` stamps. */
  export const SolanaChainCode: bigint = BigInt(
    SlugName.from(HarnessConstants.SOLANA_CHAIN_CODENAME)
  )

  /** Depot token codename used by typed syndication table reads. */
  export const LIQTokenCodename = HarnessConstants.LIQSOL_CODENAME

  /**
   * Depot token slug code the outpost's REAL liqSOL mint is registered under.
   * `synd` and `report_liq_yield` resolve it through
   * `OutpostConfig::token_code_for_mint` and refuse (`LiqTokenNotMapped`) when
   * the mint is unmapped, so the scenario maps it before syndicating.
   */
  export const LIQTokenCode: bigint = BigInt(SlugName.from(LIQTokenCodename))

  /** WIRE account receiving the entire successful syndication. */
  export const UserAccount = "synd.dest"

  /**
   * Durable handle of the flow's syndicating user keypair. It is created and
   * persisted per-cluster by the airdrop step and re-loaded by every later
   * step, so the depositor, the syndicator and the yield cranker are one
   * identity.
   */
  export const UserKeypairName = "liq-syndication-user"

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

  /** Deadline for an emitted attestation to reach an OUTPOST_SOLANA_DEPOT
   *  envelope — a single outpost→depot hop (envelope class). */
  export const CirculationTimeoutMs = ProtocolTiming.SingleHopBudgetMs
  /** Interval between opp-debugging artifact scans (ms). */
  export const CirculationPollMs = 2_000

  /** Ceiling on each Solana write step (one test-validator tx + confirmation). */
  export const OutpostWriteTimeoutMs = ProtocolTiming.OutpostWriteBudgetMs

  /**
   * The snapshot of every outpost chain's `current_epoch_index` taken before the syndication
   * (`EpochAdvanceSteps.epochIndicesKey`); the depot must keep advancing past it WHILE carrying
   * envelopes with attestation types its dispatcher does not know.
   */
  export const PreSyndicationEpochSnapshot = "liq-syndication.pre-syndication"
}
