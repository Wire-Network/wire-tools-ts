import { SlugName } from "@wireio/sdk-core"

import {
  SwapRouteCatalog,
  SwapRouteEndpoint,
  SwapRouteSelector,
  SwapRouteSourceKind
} from "@wireio/cluster-tool/tools/all"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"

describe("SwapRouteCatalog", () => {
  const routes = SwapRouteCatalog.fromReserveRegistrations(
    Steps.registry.MockReserveRegistrations
  )

  it("builds the 48 legal public routes without same-outpost pairs", () => {
    expect(routes).toHaveLength(48)
    expect(
      routes.every(
        route => route.source.endpoint !== route.destination.endpoint
      )
    ).toBe(true)
    expect(new Set(routes.map(route => route.id)).size).toBe(48)
  })

  it("preserves source-chain precision and transaction kind", () => {
    const liqEth = routes.find(
        route => route.source.symbol === "LIQETH"
      )?.source,
      usdcSol = routes.find(route => route.source.symbol === "USDCSOL")?.source
    expect(liqEth).toMatchObject({
      endpoint: SwapRouteEndpoint.ETHEREUM,
      sourcePrecision: 18,
      sourceKind: SwapRouteSourceKind.ERC20
    })
    expect(usdcSol).toMatchObject({
      endpoint: SwapRouteEndpoint.SOLANA,
      sourcePrecision: 6,
      sourceKind: SwapRouteSourceKind.SPL
    })
  })

  it("selects the six native canary directions by default", () => {
    const selected = SwapRouteCatalog.select(routes, [SwapRouteSelector.canary])
    expect(selected.map(route => route.id)).toEqual([
      "eth-to-sol",
      "sol-to-eth",
      "eth-to-wire",
      "wire-to-eth",
      "sol-to-wire",
      "wire-to-sol"
    ])
  })

  it("unions and de-duplicates endpoint and direction selectors", () => {
    const selected = SwapRouteCatalog.select(routes, [
      SwapRouteSelector["eth-to-sol"],
      SwapRouteSelector.eth
    ])
    expect(selected).toHaveLength(40)
    expect(
      selected.every(
        route =>
          route.source.endpoint === SwapRouteEndpoint.ETHEREUM ||
          route.destination.endpoint === SwapRouteEndpoint.ETHEREUM
      )
    ).toBe(true)
  })

  it("rejects an unsupported chain registration", () => {
    const invalid = {
      ...Steps.registry.MockReserveRegistrations[0],
      chain_code: { value: SlugName.from("UNKNOWN") }
    }
    expect(() => SwapRouteCatalog.fromReserveRegistrations([invalid])).toThrow(
      /unsupported public swap chain/
    )
  })

  it("validates raw CLI selector values", () => {
    expect(SwapRouteCatalog.parseSelectors(["canary", "wire-to-sol"])).toEqual([
      SwapRouteSelector.canary,
      SwapRouteSelector["wire-to-sol"]
    ])
    expect(() => SwapRouteCatalog.parseSelectors(["same-outpost"])).toThrow(
      /unsupported swap route selector/
    )
  })
})
