import { SlugName, SysioContracts } from "@wireio/sdk-core"

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

  it("uses active public live identities and falls back to LIQSOL for canary", () => {
    const eth = liveRow(Steps.registry.MockReserveRegistrations[0]),
      sol = liveRow(Steps.registry.MockReserveRegistrations[4], {
        status: SysioContracts.SysioReservReservestatus.RESERVE_STATUS_PENDING
      }),
      liqsol = liveRow(Steps.registry.MockReserveRegistrations[5], {
        reserve_code: { value: SlugName.from("PUB") }
      }),
      privateLiqsol = liveRow(Steps.registry.MockReserveRegistrations[5], {
        reserve_code: { value: SlugName.from("PRIVATE") },
        is_private: true
      }),
      liveRoutes = SwapRouteCatalog.fromLiveReserveRows([
        eth,
        sol,
        liqsol,
        privateLiqsol
      ]),
      selected = SwapRouteCatalog.select(liveRoutes, [SwapRouteSelector.canary])
    expect(selected.map(route => route.id)).toEqual([
      "eth-to-sol-liqsol-pub",
      "sol-liqsol-pub-to-eth",
      "eth-to-wire",
      "wire-to-eth",
      "sol-liqsol-pub-to-wire",
      "wire-to-sol-liqsol-pub"
    ])
    expect(selected[0].source).toMatchObject({
      sourceKind: SwapRouteSourceKind.NATIVE,
      sourcePrecision: 18
    })
    expect(selected[1].source).toMatchObject({
      reserveCode: SlugName.from("PUB"),
      sourceKind: SwapRouteSourceKind.SPL,
      sourcePrecision: 9
    })
  })

  it("keeps routes and labels distinct when one token has multiple public reserves", () => {
    const eth = liveRow(Steps.registry.MockReserveRegistrations[0]),
      alternateEth = liveRow(Steps.registry.MockReserveRegistrations[0], {
        reserve_code: { value: SlugName.from("ALT") }
      }),
      sol = liveRow(Steps.registry.MockReserveRegistrations[4]),
      liveRoutes = SwapRouteCatalog.fromLiveReserveRows([
        eth,
        alternateEth,
        sol
      ]),
      alternateRoute = liveRoutes.find(route => route.id === "eth-alt-to-sol")
    expect(new Set(liveRoutes.map(route => route.id)).size).toBe(
      liveRoutes.length
    )
    expect(alternateRoute).toBeDefined()
    expect(SwapRouteCatalog.routeLabel(alternateRoute!)).toBe("ETH/ALT→SOL")
  })

  it("qualifies route ids and labels when external chains share a token symbol", () => {
    const ethUsdc = liveRow(Steps.registry.MockReserveRegistrations[2]),
      solUsdc = liveRow(Steps.registry.MockReserveRegistrations[6], {
        token_code: { value: SlugName.from("USDC") }
      }),
      liveRoutes = SwapRouteCatalog.fromLiveReserveRows([ethUsdc, solUsdc]),
      forward = liveRoutes.find(route => route.direction === "eth-to-sol"),
      reverse = liveRoutes.find(route => route.direction === "sol-to-eth")
    expect(new Set(liveRoutes.map(route => route.id)).size).toBe(
      liveRoutes.length
    )
    expect(forward?.id).toBe("eth-usdc-to-sol-usdc")
    expect(reverse?.id).toBe("sol-usdc-to-eth-usdc")
    expect(SwapRouteCatalog.routeLabel(forward!)).toBe("ETH:USDC→SOL:USDC")
  })

  it("rejects live depot precision that disagrees with native precision", () => {
    const eth = liveRow(Steps.registry.MockReserveRegistrations[0], {
      source_token_precision: 6
    })
    expect(() => SwapRouteCatalog.fromLiveReserveRows([eth])).toThrow(
      /live depot precision 6 does not match native precision 18/
    )
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

function liveRow(
  registration: SysioContracts.SysioReservRegreserveAction,
  overrides: Partial<SysioContracts.SysioReservReserveRowType> = {}
): SysioContracts.SysioReservReserveRowType {
  return {
    chain_code: registration.chain_code,
    token_code: registration.token_code,
    reserve_code: registration.reserve_code,
    name: registration.name,
    description: registration.description,
    status: SysioContracts.SysioReservReservestatus.RESERVE_STATUS_ACTIVE,
    reserve_chain_amount: registration.initial_chain_amount,
    reserve_wire_amount: registration.initial_wire_amount,
    source_token_precision: registration.source_token_precision,
    connector_weight_bps: registration.connector_weight_bps,
    creator_addr: {
      kind: SysioContracts.SysioReservChainkind.CHAIN_KIND_UNKNOWN,
      address: ""
    },
    requested_wire_amount: registration.initial_wire_amount,
    external_token_amount: registration.initial_chain_amount,
    registered_at_ms: 1,
    activated_at_ms: 1,
    cancelled_at_ms: 0,
    is_private: false,
    owner: registration.owner,
    creator_pub_key: "",
    owner_fee_bps: 0,
    owner_fee_accrued: 0,
    owner_fee_lifetime: 0,
    ...overrides
  }
}
