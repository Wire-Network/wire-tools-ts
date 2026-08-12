import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming, type WireUserResourcePolicy } from "@wireio/cluster-tool"
import {
  RealFlowMetricPolling,
  StressPrivateReserveCreateParams,
  SwapStressPhaseAmounts
} from "./swap-stress/index.js"
import { LoadLevel, LoadProfile } from "./stress-engine/index.js"

/**
 * Constants for the swap-stress saturation soak: the same-owner PRIVATE reserve
 * pair sizing (ETH native × USDCSOL non-native), the ramp campaign shape, and
 * the deterministic stress-user funding. The reserve/phase sizings COMPOSE the
 * generic `swap-stress` constants (never re-declared); protocol
 * waits derive from the {@link ProtocolTiming} envelope.
 */
export namespace SwapStressSaturationScenarioConstants {
  /**
   * Timing budgets — protocol waits pinned to their {@link ProtocolTiming}
   * class. Each poll deadline is also the enclosing step's timeout minus
   * {@link Timing.PollDeadlineBufferMs}.
   */
  export namespace Timing {
    /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
    export const EpochDurationSec = 60
    /** Outpost RESERVE_CREATE → depot PENDING row (per chain) — a single hop. */
    export const RelayDeadlineMs = RealFlowMetricPolling.RelayDeadlineMs
    /** RESERVE_READY → outpost-local record ACTIVE — a single depot→outpost hop. */
    export const ReadyDeadlineMs = ProtocolTiming.SingleHopBudgetMs
    /** SWAP_REQUEST relay + UWREQ insert (also the uwrit.a ACTIVE budget). */
    export const UwreqDeadlineMs = ProtocolTiming.SingleHopBudgetMs
    /** Per-ramp-phase payout observation ceiling — the double-hop tail. */
    export const PayoutDeadlineMs = ProtocolTiming.DoubleHopBudgetMs
    /** Interval for long-running chain-state polls (ms). */
    export const LongPollIntervalMs = RealFlowMetricPolling.LongPollIntervalMs
    /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
    export const PollDeadlineBufferMs = 30_000
    /** Flat write / snapshot ceiling (tx build + confirm headroom). */
    export const WriteDeadlineMs = 90_000
  }

  /**
   * The same-owner PRIVATE reserve pair this soak creates via the real gated
   * handshake (outpost create → depot PENDING → matchreserve → ACTIVE), plus
   * the WIRE endpoint identity the SWAP_REQUEST envelopes carry.
   */
  export namespace Reserves {
    /** Shared reserve discriminator for both private reserves. */
    export const PrivateReserveCode = SlugName.from("PRIVATE")

    export namespace Ethereum {
      export const ChainCode = SlugName.from("ETHEREUM")
      /** Native ETH — the pair's native side. */
      export const TokenCode = SlugName.from("ETH")
    }
    export namespace Solana {
      export const ChainCode = SlugName.from("SOLANA")
      /** USDC-on-SOL mock SPL (6 decimals) — the pair's non-native side. */
      export const TokenCode = SlugName.from("USDCSOL")
      /** Native SOL — only used for underwriter bond configuration. */
      export const NativeTokenCode = SlugName.from("SOL")
    }
    export namespace Wire {
      export const ChainCode = SlugName.from("WIRE")
      export const TokenCode = SlugName.from("WIRE")
      /** Non-zero sentinel the outpost requires on a to-WIRE SwapRequest. */
      export const SentinelReserveCode = SlugName.from("PRIMARY")
    }
  }

  /**
   * create_reserve parameters — COMPOSED from
   * {@link StressPrivateReserveCreateParams} (the reserves are sized ~1000× the
   * per-swap draw so the ramp's many low-value swaps stay well inside the
   * constant-product tolerance) plus flow-local display metadata.
   */
  export namespace CreateParams {
    /** ETH escrow — 1000 ETH in wei; `toDepot(·, 18)` downscales ÷1e9. */
    export const EthereumEscrowWei = StressPrivateReserveCreateParams.EthereumEscrowWei
    /** Depot-frame seed the ETH escrow lands as on the depot row. */
    export const EthereumEscrowDepotUnits =
      StressPrivateReserveCreateParams.EthereumEscrowDepotUnits
    /** WIRE (raw 9-dp) the owner matches against the ETH reserve. */
    export const EthereumRequestedWire =
      StressPrivateReserveCreateParams.EthereumRequestedWire
    /** USDCSOL escrow — 6-dec base units; at/below the cap → identity. */
    export const SolanaEscrowChainUnits =
      StressPrivateReserveCreateParams.SolanaEscrowChainUnits
    /** Depot-frame seed the USDCSOL escrow lands as on the depot row. */
    export const SolanaEscrowDepotUnits =
      StressPrivateReserveCreateParams.SolanaEscrowDepotUnits
    /** WIRE (raw 9-dp) the owner matches against the SOL reserve. */
    export const SolanaRequestedWire =
      StressPrivateReserveCreateParams.SolanaRequestedWire
    /** 50% Bancor connector weight = pure constant product. */
    export const ConnectorWeightBps =
      StressPrivateReserveCreateParams.ConnectorWeightBps
    /** Display metadata forwarded verbatim to the depot rows. */
    export const EthereumName = "ETHEREUM-ETH/WIRE stress reserve"
    export const EthereumDescription =
      "flow-swap-stress-saturation ETH-side private reserve"
    export const SolanaName = "SOLANA-USDCSOL/WIRE stress reserve"
    export const SolanaDescription =
      "flow-swap-stress-saturation SOL-side private reserve"
  }

  /**
   * Per-swap source amounts — COMPOSED from {@link SwapStressPhaseAmounts}.
   * Phase 1 sources native ETH via the outpost `requestSwap`; Phase 2 sources
   * WIRE via `sysio.uwrit::swapfromwire`.
   */
  export namespace SwapAmounts {
    /** Phase 1: 0.1 ETH in wei. */
    export const Phase1SourceWei = SwapStressPhaseAmounts.Phase1SourceWei
    export const Phase1SourceDepotUnits =
      SwapStressPhaseAmounts.Phase1SourceDepotUnits
    /** Phase 2: USDCSOL payout leg source (6-dec base units). */
    export const Phase2SourceSplUnits = SwapStressPhaseAmounts.Phase2SourceSplUnits
    /** Phase 2: WIRE sourced by each `swapfromwire` (raw 9-dp). */
    export const Phase2SourceWireUnits =
      SwapStressPhaseAmounts.Phase2SourceWireUnits
    export const Phase2SourceDepotUnits =
      SwapStressPhaseAmounts.Phase2SourceDepotUnits
  }

  /**
   * The saturation ramp shape: doubling swap counts from {@link InitialCount}
   * to {@link MaxCount}, reusing the earliest {@link MaxCount} deterministic
   * stress accounts across {@link MaxIterationCount} iterations, with
   * {@link Concurrency} in-flight swaps per phase.
   *
   * Sizing (calibrated against the 2026-07-24 r5/r6 runs): attestations run
   * ~300 bytes, so a cap-packed 62KB+ envelope (the `byte_threshold`
   * saturation signal) needs ~210+ attestations landing in ONE epoch per
   * direction. 48 accounts peaked at 14.8KB (23% of cap) — the ramp now runs
   * 48→96→192→384→512, with the byte gate expected to trip around the
   * 384-account iteration on both Ethereum directions.
   */
  export namespace Ramp {
    /**
     * Resolved intensity for this run.
     *
     * Selected by `WIRE_STRESS_LOAD_LEVEL` — a UNIFORM operator override the
     * e2e gate sets once in shared job env for every flow, never per-flow (see
     * `e2e-tests-no-per-flow-env-customization.md`). The fallback is
     * `saturating`, whose preset is byte-for-byte the calibrated soak this flow
     * has always run, so an unset environment changes nothing.
     *
     * Only the ramp curve and the byte gate are taken from the profile — the
     * two knobs the level exists to move. {@link Concurrency} stays this flow's
     * own constant: the profile's workload describes the CLI's per-wallet swap
     * batching, which is not this campaign's phase-concurrency semantics.
     */
    const Profile = LoadProfile.resolve({
      level: LoadProfile.resolveLevel(process.env, LoadLevel.saturating)
    })

    export const Level = Profile.level
    export const InitialCount = Profile.ramp.initialCount
    export const Multiplier = Profile.ramp.multiplier
    export const MaxCount = Profile.ramp.maxCount
    export const PhaseTimeoutMs = Profile.ramp.phaseTimeoutMs
    /** Derived from the curve so funding/provisioning can never drift from it. */
    export const MaxIterationCount = LoadProfile.iterationCount(Profile.ramp)
    /**
     * Every rung's account count, in ramp order.
     *
     * The campaign registers one Phase per entry at PLAN time — the curve is
     * static, so the rungs need not be discovered at run time.
     */
    export const RungAccountCounts = LoadProfile.accountCurve(Profile.ramp)
    /**
     * Raw envelope bytes counted as saturated. At `saturating` this is the
     * engine's 95%-of-cap default (unchanged); lighter levels lower it so the
     * campaign measures ITS OWN target rather than the protocol maximum.
     */
    export const SaturatedEnvelopeMinBytes = Profile.saturatedEnvelopeMinBytes
    export const Concurrency = 4
  }

  /** WIRE accounts provisioned by this soak. */
  export namespace Accounts {
    /** The single WIRE account that matches (and therefore owns) BOTH private
     *  reserves — the pair's same-owner predicate. */
    export const Owner = "stressown"
    /** 2× the two requested WIRE amounts so both matches clear with slack. */
    export const OwnerFunding =
      2n *
      (CreateParams.EthereumRequestedWire + CreateParams.SolanaRequestedWire)
  }

  /**
   * Deterministic stress WIRE accounts — the swapfromwire recipients the ramp
   * reuses. {@link Count} accounts are provisioned at setup, each funded to
   * source its `swapfromwire` across every ramp iteration.
   */
  export namespace StressAccounts {
    /** How many deterministic stress accounts to provision (the ramp ceiling). */
    export const Count = Ramp.MaxCount
    /** Raw 9-dp WIRE funding per stress account (source × iterations × slack). */
    export const Funding =
      SwapAmounts.Phase2SourceWireUnits *
      BigInt(Ramp.MaxIterationCount) *
      2n
    /**
     * Lightweight ROA policy for the disposable stress users. The bootstrap
     * node owner's tier-1 reserve (4% of `ROA_TOTAL_SYS` ≈ 3,019 SYS) has
     * only ~300 SYS of headroom left once the bootstrap + flow-owner
     * policies are issued, so the {@link Count}-account roster must stay
     * inside that: 512 × 3 × 0.1 SYS ≈ 154 SYS. Each account only pushes one
     * tiny `swapfromwire` per iteration; 0.1 SYS of RAM weight (~100KB via
     * `ROA_BYTES_PER_UNIT`) is ample.
     */
    export const Policy: WireUserResourcePolicy = {
      netWeight: "0.1000 SYS",
      ramWeight: "0.1000 SYS",
      cpuWeight: "0.1000 SYS"
    }
  }

  /** SPL funding for the SOL-side create escrow + the Phase 2 source custody. */
  export namespace SplFunding {
    /** Escrow + every ramp iteration's Phase 2 source + headroom. */
    export const CreatorMintAmount =
      CreateParams.SolanaEscrowChainUnits * 2n +
      SwapAmounts.Phase2SourceSplUnits * BigInt(Ramp.MaxCount)
  }

  /**
   * Underwriter provisioning: the depot's `createuwreq` re-checks
   * `meets_role_min` for BOTH legs of every swap, and the underwriter plugin's
   * `select_coverable` requires a non-zero credit-line bucket per (chain,
   * token) — so the underwriter bonds on every leg the ramp touches: native
   * ETH, native SOL, and the non-native USDCSOL leg.
   */
  export namespace Underwriting {
    /** Per-(chain, token) `req_uw_collat` minimum bond (raw base units). */
    export const MinimumBond = 1_000_000_000
    /** ETH-leg collateral — sized for the full ramp's phase-2 remit volume. */
    export const EthereumCollateral =
      SwapAmounts.Phase2SourceWireUnits *
      BigInt(Ramp.MaxCount) *
      BigInt(Ramp.MaxIterationCount)
    /** SOL-leg (native + USDCSOL) bootstrap collateral per token. */
    export const SolanaCollateral = 1_000_000_000n
  }

  /** Mock-SPL-mint manifest the Solana outpost bootstrap persists in the cluster data dir. */

}
