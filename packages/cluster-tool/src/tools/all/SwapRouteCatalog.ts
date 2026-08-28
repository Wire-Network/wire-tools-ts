import Assert from "node:assert"

import type { SysioContracts } from "@wireio/sdk-core"
import { SlugName } from "@wireio/sdk-core"
import { match } from "ts-pattern"

import { slugValue } from "../../utils/slugUtils.js"

/** Public swap endpoint represented by one route asset. */
export enum SwapRouteEndpoint {
  ETHEREUM = "ETHEREUM",
  SOLANA = "SOLANA",
  WIRE = "WIRE"
}

/** Source transaction path required by an asset. */
export enum SwapRouteSourceKind {
  NATIVE = "NATIVE",
  ERC20 = "ERC20",
  SPL = "SPL",
  WIRE = "WIRE"
}

/** Stable selector names accepted by the swap canary CLI. */
export enum SwapRouteSelector {
  canary = "canary",
  all = "all",
  eth = "eth",
  sol = "sol",
  wire = "wire",
  "cross-outpost" = "cross-outpost",
  "wire-endpoint" = "wire-endpoint",
  "eth-to-sol" = "eth-to-sol",
  "sol-to-eth" = "sol-to-eth",
  "eth-to-wire" = "eth-to-wire",
  "wire-to-eth" = "wire-to-eth",
  "sol-to-wire" = "sol-to-wire",
  "wire-to-sol" = "wire-to-sol"
}

/** One source or destination asset in the public swap matrix. */
export interface SwapRouteAsset {
  /** Stable token symbol used in report labels and route ids. */
  readonly symbol: string
  /** Outpost or depot endpoint holding the asset. */
  readonly endpoint: SwapRouteEndpoint
  /** Packed chain slug value. */
  readonly chainCode: number
  /** Packed token slug value. */
  readonly tokenCode: number
  /** Packed reserve slug value. */
  readonly reserveCode: number
  /** Source-chain precision used to construct transaction amounts. */
  readonly sourcePrecision: number
  /** Transaction family used when this asset is the source. */
  readonly sourceKind: SwapRouteSourceKind
}

/** One legal ordered route in the public swap surface. */
export interface SwapRoute {
  /** Stable token-level route id. */
  readonly id: string
  /** Stable endpoint direction id used by CLI selectors. */
  readonly direction: SwapRouteDirection
  /** Source asset. */
  readonly source: SwapRouteAsset
  /** Destination asset. */
  readonly destination: SwapRouteAsset
}

/** Pure public-route catalog and selector implementation. */
export namespace SwapRouteCatalog {
  /**
   * Build every legal public route from canonical reserve registrations.
   *
   * @param registrations - Bootstrap or live public reserve descriptors.
   * @returns Ordered public routes, excluding same-outpost pairs.
   */
  export function fromReserveRegistrations(
    registrations: readonly SysioContracts.SysioReservRegreserveAction[]
  ): readonly SwapRoute[] {
    const externalAssets = registrations.map(toExternalAsset),
      assets = [...externalAssets, WireAsset]

    assertUniqueAssets(assets)

    return DirectionOrder.flatMap(direction => {
      const [sourceEndpoint, destinationEndpoint] =
        DirectionEndpoints.get(direction)!
      return assets
        .filter(asset => asset.endpoint === sourceEndpoint)
        .flatMap(source =>
          assets
            .filter(asset => asset.endpoint === destinationEndpoint)
            .map(destination => route(direction, source, destination))
        )
    })
  }

  /**
   * Select and de-duplicate routes using one or more stable CLI selectors.
   *
   * @param routes - Canonical ordered public routes.
   * @param selectors - Selector union requested by the caller.
   * @returns Selected routes in canonical order.
   */
  export function select(
    routes: readonly SwapRoute[],
    selectors: readonly SwapRouteSelector[]
  ): readonly SwapRoute[] {
    Assert.ok(
      selectors.length > 0,
      "at least one swap route selector is required"
    )
    const selectedIds = new Set<string>()
    for (const selector of selectors) {
      matching(routes, selector).forEach(route => selectedIds.add(route.id))
    }
    return routes.filter(route => selectedIds.has(route.id))
  }

  /**
   * Parse and validate repeatable CLI selector values.
   *
   * @param values - Raw repeatable CLI option values.
   * @returns Validated route selectors.
   */
  export function parseSelectors(
    values: readonly string[]
  ): SwapRouteSelector[] {
    const allowed = new Set<string>(Object.values(SwapRouteSelector))
    return values.map(value => {
      Assert.ok(allowed.has(value), `unsupported swap route selector: ${value}`)
      return value as SwapRouteSelector
    })
  }

  function matching(
    routes: readonly SwapRoute[],
    selector: SwapRouteSelector
  ): readonly SwapRoute[] {
    return match(selector)
      .with(SwapRouteSelector.all, () => routes)
      .with(SwapRouteSelector.canary, () =>
        routes
          .filter(route => isNativeEndpointAsset(route.source))
          .filter(route => isNativeEndpointAsset(route.destination))
      )
      .with(SwapRouteSelector.eth, () =>
        touching(routes, SwapRouteEndpoint.ETHEREUM)
      )
      .with(SwapRouteSelector.sol, () =>
        touching(routes, SwapRouteEndpoint.SOLANA)
      )
      .with(SwapRouteSelector.wire, () =>
        touching(routes, SwapRouteEndpoint.WIRE)
      )
      .with(SwapRouteSelector["cross-outpost"], () =>
        routes.filter(
          route =>
            route.source.endpoint !== SwapRouteEndpoint.WIRE &&
            route.destination.endpoint !== SwapRouteEndpoint.WIRE
        )
      )
      .with(SwapRouteSelector["wire-endpoint"], () =>
        touching(routes, SwapRouteEndpoint.WIRE)
      )
      .otherwise(direction =>
        routes.filter(route => route.direction === direction)
      )
  }
}

const WireAsset: SwapRouteAsset = {
  symbol: "WIRE",
  endpoint: SwapRouteEndpoint.WIRE,
  chainCode: SlugName.from("WIRE"),
  tokenCode: SlugName.from("WIRE"),
  // Outpost request contracts require a non-zero target reserve code even
  // though the depot-native WIRE endpoint has no reserve row of its own.
  reserveCode: SlugName.from("PRIMARY"),
  sourcePrecision: 9,
  sourceKind: SwapRouteSourceKind.WIRE
}

const DirectionOrder = [
  SwapRouteSelector["eth-to-sol"],
  SwapRouteSelector["sol-to-eth"],
  SwapRouteSelector["eth-to-wire"],
  SwapRouteSelector["wire-to-eth"],
  SwapRouteSelector["sol-to-wire"],
  SwapRouteSelector["wire-to-sol"]
] as const

/** One of the six legal ordered public endpoint directions. */
export type SwapRouteDirection = (typeof DirectionOrder)[number]

const DirectionEndpoints = new Map<
  SwapRouteDirection,
  readonly [SwapRouteEndpoint, SwapRouteEndpoint]
>([
  [
    SwapRouteSelector["eth-to-sol"],
    [SwapRouteEndpoint.ETHEREUM, SwapRouteEndpoint.SOLANA]
  ],
  [
    SwapRouteSelector["sol-to-eth"],
    [SwapRouteEndpoint.SOLANA, SwapRouteEndpoint.ETHEREUM]
  ],
  [
    SwapRouteSelector["eth-to-wire"],
    [SwapRouteEndpoint.ETHEREUM, SwapRouteEndpoint.WIRE]
  ],
  [
    SwapRouteSelector["wire-to-eth"],
    [SwapRouteEndpoint.WIRE, SwapRouteEndpoint.ETHEREUM]
  ],
  [
    SwapRouteSelector["sol-to-wire"],
    [SwapRouteEndpoint.SOLANA, SwapRouteEndpoint.WIRE]
  ],
  [
    SwapRouteSelector["wire-to-sol"],
    [SwapRouteEndpoint.WIRE, SwapRouteEndpoint.SOLANA]
  ]
])

function toExternalAsset(
  registration: SysioContracts.SysioReservRegreserveAction
): SwapRouteAsset {
  const chainCode = slugValue(registration.chain_code),
    tokenCode = slugValue(registration.token_code),
    reserveCode = slugValue(registration.reserve_code),
    endpoint = endpointFor(chainCode),
    symbol = SlugName.toString(tokenCode)
  Assert.notStrictEqual(
    endpoint,
    SwapRouteEndpoint.WIRE,
    "WIRE is not an external reserve"
  )
  return {
    symbol,
    endpoint,
    chainCode,
    tokenCode,
    reserveCode,
    sourcePrecision: sourcePrecision(endpoint, symbol),
    sourceKind: sourceKind(endpoint, symbol)
  }
}

function endpointFor(chainCode: number): SwapRouteEndpoint {
  const codename = SlugName.toString(chainCode)
  Assert.ok(
    codename === SwapRouteEndpoint.ETHEREUM ||
      codename === SwapRouteEndpoint.SOLANA,
    `unsupported public swap chain: ${codename}`
  )
  return codename as SwapRouteEndpoint
}

function sourceKind(
  endpoint: SwapRouteEndpoint,
  symbol: string
): SwapRouteSourceKind {
  return match({ endpoint, symbol })
    .with(
      { symbol: "ETH" },
      { symbol: "SOL" },
      () => SwapRouteSourceKind.NATIVE
    )
    .with(
      { endpoint: SwapRouteEndpoint.ETHEREUM },
      () => SwapRouteSourceKind.ERC20
    )
    .otherwise(() => SwapRouteSourceKind.SPL)
}

function sourcePrecision(endpoint: SwapRouteEndpoint, symbol: string): number {
  return match({ endpoint, symbol })
    .with(
      { endpoint: SwapRouteEndpoint.ETHEREUM, symbol: "ETH" },
      { endpoint: SwapRouteEndpoint.ETHEREUM, symbol: "LIQETH" },
      () => 18
    )
    .with(
      { symbol: "USDC" },
      { symbol: "USDT" },
      { symbol: "USDCSOL" },
      { symbol: "USDTSOL" },
      () => 6
    )
    .otherwise(() => 9)
}

function route(
  direction: SwapRouteDirection,
  source: SwapRouteAsset,
  destination: SwapRouteAsset
): SwapRoute {
  return {
    id: `${source.symbol.toLowerCase()}-to-${destination.symbol.toLowerCase()}`,
    direction,
    source,
    destination
  }
}

function isNativeEndpointAsset(asset: SwapRouteAsset): boolean {
  return (
    asset.sourceKind === SwapRouteSourceKind.NATIVE ||
    asset.sourceKind === SwapRouteSourceKind.WIRE
  )
}

function touching(
  routes: readonly SwapRoute[],
  endpoint: SwapRouteEndpoint
): readonly SwapRoute[] {
  return routes.filter(
    route =>
      route.source.endpoint === endpoint ||
      route.destination.endpoint === endpoint
  )
}

function assertUniqueAssets(assets: readonly SwapRouteAsset[]): void {
  const ids = assets.map(
    asset => `${asset.chainCode}:${asset.tokenCode}:${asset.reserveCode}`
  )
  Assert.strictEqual(
    new Set(ids).size,
    ids.length,
    "swap route assets must be unique"
  )
}
