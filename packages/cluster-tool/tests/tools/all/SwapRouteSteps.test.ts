import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import { Report } from "@wireio/cluster-tool/report"
import {
  SwapRouteCatalog,
  SwapRouteSelector,
  SwapRouteSteps
} from "@wireio/cluster-tool/tools/all"
import { SlugName, type SysioContracts } from "@wireio/sdk-core"

describe("SwapRouteSteps", () => {
  const routes = SwapRouteCatalog.fromReserveRegistrations(
      Steps.registry.MockReserveRegistrations
    ),
    nativeRoute = SwapRouteCatalog.select(routes, [
      SwapRouteSelector["eth-to-sol"]
    ])[0],
    erc20Route = routes.find(route => route.source.symbol === "USDC")!

  it("names target outputs by exact route", () => {
    expect(SwapRouteSteps.targetOutputKey(nativeRoute.id).name).toBe(
      "swapRoute.eth-to-sol.target"
    )
    expect(SwapRouteSteps.sourceRequestIdOutputKey(nativeRoute.id).name).toBe(
      "swapRoute.eth-to-sol.sourceRequestId"
    )
  })

  it("decodes external source ids as big-endian", () => {
    expect(
      SwapRouteSteps.decodeUwreqSourceRequestId({
        src_chain_code: { value: SlugName.from("ETHEREUM") },
        source_tx_id: "000000000000002a"
      } as SysioContracts.SysioUwritUwRequestTType)
    ).toBe(42n)
  })

  it("decodes depot-origin WIRE source ids as little-endian", () => {
    expect(
      SwapRouteSteps.decodeUwreqSourceRequestId({
        src_chain_code: { value: SlugName.from("WIRE") },
        source_tx_id: "0700000000000080"
      } as SysioContracts.SysioUwritUwRequestTType)
    ).toBe((1n << 63n) | 7n)
  })

  it("builds an ERC-20 approval Step with exact route and amount", () => {
    const step = SwapRouteSteps.planErc20Approval(
      Report.Actor.User,
      "approve-usdc",
      "approve source",
      {},
      erc20Route,
      100n
    )
    expect(step.input.kind).toBe("SwapRouteSteps.ApproveErc20Input")
    expect(step.input.route.id).toBe(erc20Route.id)
    expect(step.input.amount).toBe(100n)
  })

  it("rejects an approval for a native source before resolving context", async () => {
    await expect(
      SwapRouteSteps.runErc20Approval(
        null as never,
        {
          kind: "SwapRouteSteps.ApproveErc20Input",
          route: nativeRoute,
          amount: 100n
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/requires an ERC-20 source/)
  })

  it("builds one source request Step with all static route inputs", () => {
    const step = SwapRouteSteps.planRequest(
      Report.Actor.User,
      "request-eth-to-sol",
      "request route",
      {},
      nativeRoute,
      100n,
      500,
      "swapcanary"
    )
    expect(step.input).toMatchObject({
      kind: "SwapRouteSteps.RequestInput",
      route: nativeRoute,
      sourceAmount: 100n,
      targetToleranceBps: 500,
      wireAccount: "swapcanary"
    })
  })

  it("rejects a non-positive source amount before resolving context", async () => {
    await expect(
      SwapRouteSteps.runRequest(
        null as never,
        {
          kind: "SwapRouteSteps.RequestInput",
          route: nativeRoute,
          sourceAmount: 0n,
          targetToleranceBps: 500,
          wireAccount: "swapcanary"
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/source amount must be positive/)
  })
})
