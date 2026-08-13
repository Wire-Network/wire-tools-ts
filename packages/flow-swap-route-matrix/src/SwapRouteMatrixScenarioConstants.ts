import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/** A native endpoint represented in the six-route matrix. */
export enum SwapRouteEndpoint {
  Ethereum = "ethereum",
  Solana = "solana",
  Wire = "wire"
}

/** Immutable build-time description of one native directional route. */
export interface SwapRoute {
  /** Stable route id used in report text and typed output keys. */
  readonly id: string
  /** Human-readable direction shown in the report. */
  readonly label: string
  /** Source endpoint. */
  readonly source: SwapRouteEndpoint
  /** Destination endpoint. */
  readonly destination: SwapRouteEndpoint
  /** Source amount in the source chain's native base units. */
  readonly sourceAmount: bigint
  /** Source token decimals used for the depot-frame conversion. */
  readonly sourceDecimals: number
  /** Destination token decimals used for the native payout floor. */
  readonly destinationDecimals: number
  /** Expected persistent underwriter locks for the route. */
  readonly expectedLockCount: number
}

/** Constants and the six native route descriptors for the matrix flow. */
export namespace SwapRouteMatrixScenarioConstants {
  /** Minimum supported epoch duration. */
  export const EpochDurationSec = 60
  /** Ceiling for one request transaction. */
  export const WriteTimeoutMs = 60_000
  /** Poll cadence for protocol state transitions. */
  export const PollIntervalMs = 3_000
  /** Timeout headroom beyond a protocol poll deadline. */
  export const PollDeadlineBufferMs = 30_000
  /** SWAP_REQUEST or from-WIRE queue delivery to a depot UWREQ. */
  export const UwreqDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Underwriter race resolution. */
  export const RaceDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Destination remit and balance credit. */
  export const PayoutDeadlineMs = ProtocolTiming.DoubleHopBudgetMs
  /** Underwriter collateral delivery and ACTIVE eligibility. */
  export const UnderwriterActiveDeadlineMs = ProtocolTiming.DoubleHopBudgetMs

  /** Registered chain codes. */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  export const WireChainCode = SlugName.from("WIRE")
  /** Registered native token codes. */
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")
  export const WireTokenCode = SlugName.from("WIRE")
  /** Public reserve code used on both outposts and as the WIRE sentinel. */
  export const PrimaryReserveCode = SlugName.from("PRIMARY")

  /** Native ETH uses 18 decimals. */
  export const EthereumDecimals = 18
  /** Native SOL and WIRE use the depot's 9-decimal frame. */
  export const DepotDecimals = 9
  /** 0.1 ETH, expressed as wei. */
  export const SourceEthereumWei = 100_000_000_000_000_000n
  /** 0.1 SOL, expressed as lamports. */
  export const SourceSolanaLamports = 100_000_000n
  /** 0.1 WIRE, expressed in base units. */
  export const SourceWireUnits = 100_000_000n
  /** User-supplied variance tolerance for every route. */
  export const ToleranceBps = 500
  /** Collateral minimum matched by the existing default underwriter bond plan. */
  export const UnderwriterMinimumBond = 1_000_000_000

  /** Shared WIRE endpoint account used as recipient and funded depositor. */
  export const WireUserAccount = "swapmatrix"
  /** Enough WIRE for both from-WIRE source routes plus rerun headroom. */
  export const WireUserFunding = 1_000_000_000n
  /** Ethereum outpost address/ABI artifact key. */
  export const ReserveManagerContractName = "ReserveManager"
  /** Maximum operator rows inspected by the ACTIVE prerequisite. */
  export const OperatorTableRowLimit = 100
  /** No pre-existing UWREQ id for a route. */
  export const NoUwreqBaselineId = -1

  /** External-to-external routes have a source and destination lock. */
  export const CrossOutpostLockCount = 2
  /** Routes with WIRE as one endpoint have only the outpost-side lock. */
  export const WireEndpointLockCount = 1

  /** ETH → SOL and SOL → ETH. */
  export const CrossOutpostRoutes: readonly SwapRoute[] = [
    {
      id: "ethereum-to-solana",
      label: "ETH → SOL",
      source: SwapRouteEndpoint.Ethereum,
      destination: SwapRouteEndpoint.Solana,
      sourceAmount: SourceEthereumWei,
      sourceDecimals: EthereumDecimals,
      destinationDecimals: DepotDecimals,
      expectedLockCount: CrossOutpostLockCount
    },
    {
      id: "solana-to-ethereum",
      label: "SOL → ETH",
      source: SwapRouteEndpoint.Solana,
      destination: SwapRouteEndpoint.Ethereum,
      sourceAmount: SourceSolanaLamports,
      sourceDecimals: DepotDecimals,
      destinationDecimals: EthereumDecimals,
      expectedLockCount: CrossOutpostLockCount
    }
  ]

  /** ETH → WIRE and SOL → WIRE. */
  export const ExternalToWireRoutes: readonly SwapRoute[] = [
    {
      id: "ethereum-to-wire",
      label: "ETH → WIRE",
      source: SwapRouteEndpoint.Ethereum,
      destination: SwapRouteEndpoint.Wire,
      sourceAmount: SourceEthereumWei,
      sourceDecimals: EthereumDecimals,
      destinationDecimals: DepotDecimals,
      expectedLockCount: WireEndpointLockCount
    },
    {
      id: "solana-to-wire",
      label: "SOL → WIRE",
      source: SwapRouteEndpoint.Solana,
      destination: SwapRouteEndpoint.Wire,
      sourceAmount: SourceSolanaLamports,
      sourceDecimals: DepotDecimals,
      destinationDecimals: DepotDecimals,
      expectedLockCount: WireEndpointLockCount
    }
  ]

  /** WIRE → ETH and WIRE → SOL. */
  export const WireToExternalRoutes: readonly SwapRoute[] = [
    {
      id: "wire-to-ethereum",
      label: "WIRE → ETH",
      source: SwapRouteEndpoint.Wire,
      destination: SwapRouteEndpoint.Ethereum,
      sourceAmount: SourceWireUnits,
      sourceDecimals: DepotDecimals,
      destinationDecimals: EthereumDecimals,
      expectedLockCount: WireEndpointLockCount
    },
    {
      id: "wire-to-solana",
      label: "WIRE → SOL",
      source: SwapRouteEndpoint.Wire,
      destination: SwapRouteEndpoint.Solana,
      sourceAmount: SourceWireUnits,
      sourceDecimals: DepotDecimals,
      destinationDecimals: DepotDecimals,
      expectedLockCount: WireEndpointLockCount
    }
  ]
}
