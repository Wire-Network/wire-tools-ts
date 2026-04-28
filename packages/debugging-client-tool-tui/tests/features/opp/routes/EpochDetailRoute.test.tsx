import { EpochDetailRoute } from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/routes/EpochDetailRoute.js"

describe("EpochDetailRoute", () => {
  it("declares stable id / Name / route path", () => {
    expect(EpochDetailRoute.id).toBe("opp:epoch-detail")
    expect(EpochDetailRoute.Name).toBe("OPP Epoch")
    expect(EpochDetailRoute.RoutePath).toBe("/opp/epoch")
  })

  it("is a React function component", () => {
    expect(typeof EpochDetailRoute).toBe("function")
  })

  it("declares the visual constants the renderer relies on", () => {
    expect(EpochDetailRoute.DetailBorderStyle).toBe("round")
    expect(EpochDetailRoute.BorderColorFocused).toBe("cyan")
    expect(EpochDetailRoute.BorderColorUnfocused).toBe("gray")
  })
})
