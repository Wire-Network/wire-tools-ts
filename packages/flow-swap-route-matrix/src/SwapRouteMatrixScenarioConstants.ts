import { ProtocolTiming } from "@wireio/cluster-tool"
import { SlugName } from "@wireio/sdk-core"

/** Outpost/depot location of a configured swap token. */
export enum SwapRouteEndpoint {
  Ethereum = "ethereum",
  Solana = "solana",
  Wire = "wire"
}

/** Source transaction path required by a configured token. */
export enum SwapRouteSourceKind {
  Native = "native",
  Erc20Permit = "erc20-permit",
  Erc20Approval = "erc20-approval",
  Spl = "spl",
  Wire = "wire"
}

/** Build-time metadata required to exercise one configured swap token. */
export interface SwapRouteToken {
  /** Stable token id used in route ids and output keys. */
  readonly id: string
  /** Token symbol shown in reports. */
  readonly symbol: string
  /** Chain/outpost holding the token. */
  readonly endpoint: SwapRouteEndpoint
  /** Registered chain slug value. */
  readonly chainCode: number
  /** Registered token slug value. */
  readonly tokenCode: number
  /** Chain-native decimals used at the depot precision boundary. */
  readonly decimals: number
  /** Source amount in chain-native base units. */
  readonly sourceAmount: bigint
  /** Source request path for this token. */
  readonly sourceKind: SwapRouteSourceKind
}

/** Immutable description of one exact directional route. */
export interface SwapRoute {
  /** Stable route id used in report text and typed output keys. */
  readonly id: string
  /** Human-readable token direction shown in the report. */
  readonly label: string
  /** Exact source token. */
  readonly source: SwapRouteToken
  /** Exact destination token. */
  readonly destination: SwapRouteToken
  /** Expected persistent underwriter locks for the route. */
  readonly expectedLockCount: number
}

/** One reusable direction group within the exhaustive matrix. */
export interface SwapRouteDirection {
  /** Stable PascalCase group name. */
  readonly name: string
  /** Human-readable direction description. */
  readonly description: string
  /** Exact token-pair phases in this direction. */
  readonly routes: readonly SwapRoute[]
}

/** One reusable route-family group within the exhaustive matrix. */
export interface SwapRouteFamily {
  /** Stable PascalCase group name. */
  readonly name: string
  /** Human-readable family description. */
  readonly description: string
  /** Direction groups in this family. */
  readonly directions: readonly SwapRouteDirection[]
}

/** Constants and generated descriptors for the exhaustive configured matrix. */
export namespace SwapRouteMatrixScenarioConstants {
  /** Generic flow-orchestration override for collect-all versus fail-fast. */
  export const FailureModeEnvVar = "WIRE_FLOW_FAILURE_MODE"
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
  /** Registered reserve code used by every configured public route. */
  export const PrimaryReserveCode = SlugName.from("PRIMARY")

  /** Native Ethereum token symbol. */
  export const EthereumNativeSymbol = "ETH"
  /** Ethereum liquid-staking token symbol. */
  export const LiqEthSymbol = "LIQETH"
  /** Ethereum USDC token symbol. */
  export const EthereumUsdcSymbol = "USDC"
  /** Ethereum USDT token symbol. */
  export const EthereumUsdtSymbol = "USDT"
  /** Native Solana token symbol. */
  export const SolanaNativeSymbol = "SOL"
  /** Solana liquid-staking token symbol. */
  export const LiqSolSymbol = "LIQSOL"
  /** Solana USDC token symbol. */
  export const SolanaUsdcSymbol = "USDCSOL"
  /** Solana USDT token symbol. */
  export const SolanaUsdtSymbol = "USDTSOL"
  /** Depot-native token symbol. */
  export const WireSymbol = "WIRE"

  /** Native ETH / LIQETH precision. */
  export const EthereumDecimals = 18
  /** Native SOL / LIQSOL / WIRE precision. */
  export const DepotDecimals = 9
  /** Mock stablecoin precision on both outposts. */
  export const StableDecimals = 6
  /** 0.1 token for 18-decimal Ethereum assets. */
  export const SourceEthereumUnits = 100_000_000_000_000_000n
  /** 0.1 token for 9-decimal Solana and WIRE assets. */
  export const SourceDepotUnits = 100_000_000n
  /** 0.1 token for 6-decimal stablecoins. */
  export const SourceStableUnits = 100_000n
  /** User-supplied variance tolerance for every route. */
  export const ToleranceBps = 500
  /** Native-leg minimum mirrored into the operator eligibility config. */
  export const UnderwriterMinimumBond = 1_000_000_000
  /** Per-token collateral covering all persistent locks in the 72-route run. */
  export const UnderwriterCollateralAmount = 15_000_000_000n

  /** Shared WIRE endpoint account used as recipient and funded depositor. */
  export const WireUserAccount = "swapmatrix"
  /** Enough WIRE for every from-WIRE route plus rerun headroom. */
  export const WireUserFunding = 2_000_000_000n
  /** Source-token funding multiplier over one route amount. */
  export const UserFundingMultiple = 12n
  /** LIQETH liquidity floor matching the configured logical reserve. */
  export const LiqEthReserveFunding = 10_000_000_000_000_000_000n
  /** Ethereum outpost address/ABI artifact key. */
  export const ReserveManagerContractName = "ReserveManager"
  /** Ethereum liqETH deposit contract artifact key. */
  export const DepositManagerContractName = "DepositManager"
  /** Maximum operator rows inspected by the collateral prerequisite. */
  export const OperatorTableRowLimit = 100
  /** No pre-existing UWREQ id for a route. */
  export const NoUwreqBaselineId = -1n
  /** EIP-2612 permit validity window. */
  export const PermitDeadlineWindowSec = 3_600

  /** External-to-external routes have a source and destination lock. */
  export const ExternalLockCount = 2
  /** Routes with WIRE as one endpoint have only the outpost-side lock. */
  export const WireEndpointLockCount = 1

  /** Configured Ethereum reserve tokens. */
  export const EthereumTokens: readonly SwapRouteToken[] = [
    token(
      "ethereum-eth",
      EthereumNativeSymbol,
      SwapRouteEndpoint.Ethereum,
      EthereumChainCode,
      EthereumDecimals,
      SourceEthereumUnits,
      SwapRouteSourceKind.Native
    ),
    token(
      "ethereum-liqeth",
      LiqEthSymbol,
      SwapRouteEndpoint.Ethereum,
      EthereumChainCode,
      EthereumDecimals,
      SourceEthereumUnits,
      SwapRouteSourceKind.Erc20Approval
    ),
    token(
      "ethereum-usdc",
      EthereumUsdcSymbol,
      SwapRouteEndpoint.Ethereum,
      EthereumChainCode,
      StableDecimals,
      SourceStableUnits,
      SwapRouteSourceKind.Erc20Permit
    ),
    token(
      "ethereum-usdt",
      EthereumUsdtSymbol,
      SwapRouteEndpoint.Ethereum,
      EthereumChainCode,
      StableDecimals,
      SourceStableUnits,
      SwapRouteSourceKind.Erc20Approval
    )
  ]

  /** Configured Solana reserve tokens. */
  export const SolanaTokens: readonly SwapRouteToken[] = [
    token(
      "solana-sol",
      SolanaNativeSymbol,
      SwapRouteEndpoint.Solana,
      SolanaChainCode,
      DepotDecimals,
      SourceDepotUnits,
      SwapRouteSourceKind.Native
    ),
    token(
      "solana-liqsol",
      LiqSolSymbol,
      SwapRouteEndpoint.Solana,
      SolanaChainCode,
      DepotDecimals,
      SourceDepotUnits,
      SwapRouteSourceKind.Spl
    ),
    token(
      "solana-usdc",
      SolanaUsdcSymbol,
      SwapRouteEndpoint.Solana,
      SolanaChainCode,
      StableDecimals,
      SourceStableUnits,
      SwapRouteSourceKind.Spl
    ),
    token(
      "solana-usdt",
      SolanaUsdtSymbol,
      SwapRouteEndpoint.Solana,
      SolanaChainCode,
      StableDecimals,
      SourceStableUnits,
      SwapRouteSourceKind.Spl
    )
  ]

  /** Configured depot-native WIRE token. */
  export const WireToken: SwapRouteToken = token(
    "wire-wire",
    WireSymbol,
    SwapRouteEndpoint.Wire,
    WireChainCode,
    DepotDecimals,
    SourceDepotUnits,
    SwapRouteSourceKind.Wire
  )

  /** Every configured external reserve token. */
  export const ExternalTokens: readonly SwapRouteToken[] = [
    ...EthereumTokens,
    ...SolanaTokens
  ]

  /** Every meaningful exact token route, grouped for report reuse. */
  export const RouteFamilies: readonly SwapRouteFamily[] = [
    {
      name: "CrossOutpostRoutes",
      description: "Every Ethereum ↔ Solana token pair",
      directions: [
        direction(
          "EthereumToSolana",
          "Every configured Ethereum token → every configured Solana token",
          EthereumTokens,
          SolanaTokens
        ),
        direction(
          "SolanaToEthereum",
          "Every configured Solana token → every configured Ethereum token",
          SolanaTokens,
          EthereumTokens
        )
      ]
    },
    {
      name: "SameOutpostRoutes",
      description: "Every distinct token pair on the same outpost",
      directions: [
        sameEndpointDirection(
          "EthereumToEthereum",
          "Every distinct configured Ethereum token pair",
          EthereumTokens
        ),
        sameEndpointDirection(
          "SolanaToSolana",
          "Every distinct configured Solana token pair",
          SolanaTokens
        )
      ]
    },
    {
      name: "ExternalToWireRoutes",
      description: "Every configured external token paid directly in WIRE",
      directions: [
        direction(
          "EthereumToWire",
          "Every configured Ethereum token → WIRE",
          EthereumTokens,
          [WireToken]
        ),
        direction(
          "SolanaToWire",
          "Every configured Solana token → WIRE",
          SolanaTokens,
          [WireToken]
        )
      ]
    },
    {
      name: "WireToExternalRoutes",
      description: "WIRE paid into every configured external token",
      directions: [
        direction(
          "WireToEthereum",
          "WIRE → every configured Ethereum token",
          [WireToken],
          EthereumTokens
        ),
        direction(
          "WireToSolana",
          "WIRE → every configured Solana token",
          [WireToken],
          SolanaTokens
        )
      ]
    }
  ]

  /** Flat exact-route catalog used by validation and report totals. */
  export const AllRoutes: readonly SwapRoute[] = RouteFamilies.flatMap(family =>
    family.directions.flatMap(routeDirection => routeDirection.routes)
  )
  /** Expected exhaustive route count: 32 cross + 24 same-outpost + 16 WIRE. */
  export const ConfiguredRouteCount = 72
}

/** Create one configured token descriptor. */
function token(
  id: string,
  symbol: string,
  endpoint: SwapRouteEndpoint,
  chainCode: number,
  decimals: number,
  sourceAmount: bigint,
  sourceKind: SwapRouteSourceKind
): SwapRouteToken {
  return {
    id,
    symbol,
    endpoint,
    chainCode,
    tokenCode: SlugName.from(symbol),
    decimals,
    sourceAmount,
    sourceKind
  }
}

/** Generate every ordered source/destination token pair for one direction. */
function direction(
  name: string,
  description: string,
  sources: readonly SwapRouteToken[],
  destinations: readonly SwapRouteToken[]
): SwapRouteDirection {
  return {
    name,
    description,
    routes: sources.flatMap(source =>
      destinations.map(destination => route(source, destination))
    )
  }
}

/** Generate every meaningful ordered pair on one outpost, excluding self. */
function sameEndpointDirection(
  name: string,
  description: string,
  tokens: readonly SwapRouteToken[]
): SwapRouteDirection {
  return {
    name,
    description,
    routes: tokens.flatMap(source =>
      tokens
        .filter(destination => destination.id !== source.id)
        .map(destination => route(source, destination))
    )
  }
}

/** Create one exact directional route. */
function route(source: SwapRouteToken, destination: SwapRouteToken): SwapRoute {
  return {
    id: `${source.id}-to-${destination.id}`,
    label: `${source.symbol} (${source.endpoint}) → ${destination.symbol} (${destination.endpoint})`,
    source,
    destination,
    expectedLockCount:
      source.endpoint === SwapRouteEndpoint.Wire ||
      destination.endpoint === SwapRouteEndpoint.Wire
        ? SwapRouteMatrixScenarioConstants.WireEndpointLockCount
        : SwapRouteMatrixScenarioConstants.ExternalLockCount
  }
}
