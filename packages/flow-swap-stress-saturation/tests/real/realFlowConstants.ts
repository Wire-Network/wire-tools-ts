import { TokenAmount } from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"
import {
  RealFlowMetricPolling,
  StressPrivateReserveCreateParams,
  SwapStressPhaseAmounts
} from "@wireio/test-flow-swap-stress-saturation"

import type { StressRampConfig } from "@wireio/test-flow-swap-stress-saturation"

/** Environment variables required to execute the real local-cluster flow. */
export const RequiredEnvVars = [
  "WIRE_BUILD_PATH",
  "WIRE_ETH_PATH",
  "WIRE_SOLANA_PATH"
] as const

/** Solana outpost PDA seed labels used by real reserve setup. */
export namespace SolanaSeeds {
  export const OutpostConfig = Buffer.from("outpost_config")
  export const OutboundMessageBuffer = Buffer.from("outbound_message_buffer")
  export const Reserve = Buffer.from("reserve")
  export const ReserveVault = Buffer.from("reserve_vault")
}

/** Real local-cluster baseline constants used before saturation ramping resumes. */
export namespace RealRamp {
  /** Swap count for the repeatable baseline burst. */
  export const BaselineCount = 3
  /** Real-flow config for the env-gated saturation ramp. */
  export const Config: StressRampConfig = {
    initialCount: BaselineCount,
    multiplier: 2,
    maxCount: 48,
    phaseTimeoutMs: 480_000
  }
  /** Number of ramp iterations that can reuse the earliest generated accounts. */
  export const MaxIterationCount = 5
  export const Concurrency = 4
}

/** Timing budgets for the real stress flow. */
export namespace Timing {
  export const EpochDurationSec = 60
  export const BootstrapTimeoutMs = 720_000
  export const RelayDeadlineMs = RealFlowMetricPolling.RelayDeadlineMs
  export const ReadyDeadlineMs = 240_000
  export const LongPollIntervalMs = RealFlowMetricPolling.LongPollIntervalMs
  export const PayoutDeadlineMs = 480_000

  /**
   * Jest budget for the env-gated real saturation ramp test.
   * Changing this changes how long the full ramp may run before Jest aborts it.
   */
  export const RealSaturationRampTimeoutMs =
    RealRamp.Config.phaseTimeoutMs * RealRamp.MaxIterationCount +
    BootstrapTimeoutMs
}

/** Private reserve route constants for ETH <-> USDCSOL. */
export namespace Reserves {
  export const PrivateReserveCode = SlugName.from("PRIVATE")
  export namespace Ethereum {
    export const ChainCode = SlugName.from("ETHEREUM")
    export const TokenCode = SlugName.from("ETH")
  }
  export namespace Solana {
    export const ChainCode = SlugName.from("SOLANA")
    export const TokenCode = SlugName.from("USDCSOL")
    export const NativeTokenCode = SlugName.from("SOL")
  }
  export namespace Wire {
    export const ChainCode = SlugName.from("WIRE")
    export const TokenCode = SlugName.from("WIRE")
    export const SentinelReserveCode = SlugName.from("PRIMARY")
  }
}

/** WIRE account and funding used to own both private reserves. */
export namespace Accounts {
  export const Owner = "stressown"
  export const OwnerFunding =
    2n *
    (StressPrivateReserveCreateParams.EthereumRequestedWire +
      StressPrivateReserveCreateParams.SolanaRequestedWire)
  /** Lightweight ROA policy for disposable stress users; keeps setup within local SYS capacity. */
  export const StressUserPolicy = {
    netWeight: "1.0000 SYS",
    ramWeight: "1.0000 SYS",
    cpuWeight: "1.0000 SYS"
  }
}

/** SPL funding for private reserve creation and the inverse stress phase. */
export namespace SplFunding {
  export const CreatorMintAmount =
    StressPrivateReserveCreateParams.SolanaEscrowChainUnits * 2n +
    SwapStressPhaseAmounts.Phase2SourceSplUnits *
      BigInt(RealRamp.Config.maxCount)
}

/** Real-flow underwriter collateral budgets sized for the full configured ramp. */
export namespace UnderwriterFunding {
  /** ETH collateral budget; changing this alters the maximum phase-2 remit volume. */
  export const EthereumAmount =
    SwapStressPhaseAmounts.Phase2SourceWireUnits *
    BigInt(RealRamp.Config.maxCount) *
    BigInt(RealRamp.MaxIterationCount)
  /** Solana bootstrap collateral per token; changing this alters setup funding needs. */
  export const SolanaAmount = 1_000_000_000n
}

/** Local ETH ReserveManager status value for ACTIVE private reserves. */
export const EthLocalReserveStatus = {
  ACTIVE: 1
} as const

/** Underwriter collateral requirements for real stress swaps. */
export function underwriterRequirements() {
  return [
    {
      chainCode: Reserves.Ethereum.ChainCode,
      tokenCode: Reserves.Ethereum.TokenCode,
      minBond: 1_000_000_000
    },
    {
      chainCode: Reserves.Solana.ChainCode,
      tokenCode: Reserves.Solana.NativeTokenCode,
      minBond: 1_000_000_000
    }
  ]
}

/** Underwriter collateral balances for native and USDCSOL legs. */
export function underwriterCollateral() {
  return [
    {
      chain_code: Reserves.Ethereum.ChainCode,
      amount: TokenAmount.create({
        tokenCode: BigInt(Reserves.Ethereum.TokenCode),
        amount: UnderwriterFunding.EthereumAmount
      })
    },
    {
      chain_code: Reserves.Solana.ChainCode,
      amount: TokenAmount.create({
        tokenCode: BigInt(Reserves.Solana.NativeTokenCode),
        amount: UnderwriterFunding.SolanaAmount
      })
    },
    {
      chain_code: Reserves.Solana.ChainCode,
      amount: TokenAmount.create({
        tokenCode: BigInt(Reserves.Solana.TokenCode),
        amount: UnderwriterFunding.SolanaAmount
      })
    }
  ]
}
