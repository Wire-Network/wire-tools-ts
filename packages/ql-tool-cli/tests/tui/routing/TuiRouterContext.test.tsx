import { act } from "react"
import TestRenderer from "react-test-renderer"

import { TuiRoute, TuiRouteOutlet, TuiRouter, TuiRouterProvider, useTuiNavigation, type TuiNavigation, type TuiRouteTable } from "@wireio/ql-tool-cli/tui/index.js"

/** Captures the navigation API. */
let navigation: TuiNavigation = null

/** Exposes navigation to the test. */
function Capture() {
  navigation = useTuiNavigation()
  return null
}

const routes: TuiRouteTable = {
  [TuiRoute.workbench]: () => <>workbench</>,
  [TuiRoute.profiles]: () => <>profiles</>,
  [TuiRoute.history]: () => <>history</>,
  [TuiRoute.saved]: () => <>saved</>,
  [TuiRoute.help]: () => <>help</>
}

describe("TuiRouterContext + TuiRouteOutlet", () => {
  it("renders the top route and follows push / replace / pop", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <TuiRouterProvider>
          <Capture />
          <TuiRouteOutlet routes={routes} />
        </TuiRouterProvider>
      )
    })
    expect(renderer.toJSON()).toBe("workbench")
    act(() => navigation.push(TuiRoute.history))
    expect(renderer.toJSON()).toBe("history")
    act(() => navigation.replace(TuiRoute.help))
    expect(renderer.toJSON()).toBe("help")
    act(() => navigation.pop())
    expect(renderer.toJSON()).toBe("workbench")
  })

  it("starts from an initial router; throws outside the provider or for a missing route component", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <TuiRouterProvider initial={new TuiRouter([TuiRoute.workbench, TuiRoute.saved])}>
          <TuiRouteOutlet routes={routes} />
        </TuiRouterProvider>
      )
    })
    expect(renderer.toJSON()).toBe("saved")
    expect(() => act(() => void TestRenderer.create(<Capture />))).toThrow(/outside a TuiRouterProvider/)
    expect(() =>
      act(() => void TestRenderer.create(<TuiRouterProvider><TuiRouteOutlet routes={{ ...routes, [TuiRoute.workbench]: undefined }} /></TuiRouterProvider>))
    ).toThrow(/no component for TUI route workbench/)
  })
})
