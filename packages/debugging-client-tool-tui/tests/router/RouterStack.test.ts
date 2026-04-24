import React from "react"
import { RouteRegistry } from "@wire-e2e-tests/debugging-client-tool-tui/router/RouteRegistry.js"
import { RouterStack } from "@wire-e2e-tests/debugging-client-tool-tui/router/RouterStack.js"
import type { Route } from "@wire-e2e-tests/debugging-client-tool-tui/router/RouteTypes.js"

function mkRoute(path: string, featureId = "test"): Route {
  return {
    path,
    featureId,
    name: path,
    component: () => React.createElement("span"),
    cyclable: true
  }
}

beforeEach(() => {
  RouteRegistry._resetForTests()
  RouteRegistry.register(mkRoute("/a"))
  RouteRegistry.register(mkRoute("/b"))
  RouteRegistry.register(mkRoute("/c"))
})

describe("RouterStack.resolve", () => {
  it("returns a RouteMatch from a registered path", () => {
    const match = RouterStack.resolve("/a")
    expect(match.route.path).toBe("/a")
    expect(match.params).toEqual({})
  })

  it("attaches params verbatim", () => {
    const match = RouterStack.resolve("/a", { id: "42" })
    expect(match.params).toEqual({ id: "42" })
  })

  it("throws on an unregistered path", () => {
    expect(() => RouterStack.resolve("/nowhere")).toThrow(/Route not found/)
  })
})

describe("RouterStack.seed / push / pop / replace / reset", () => {
  it("seed creates a one-entry stack", () => {
    const s = RouterStack.seed("/a")
    expect(s).toHaveLength(1)
    expect(RouterStack.current(s)?.route.path).toBe("/a")
  })

  it("push appends", () => {
    const s = RouterStack.push(RouterStack.seed("/a"), "/b")
    expect(s.map(m => m.route.path)).toEqual(["/a", "/b"])
  })

  it("pop removes one", () => {
    const s = RouterStack.pop(RouterStack.push(RouterStack.seed("/a"), "/b"))
    expect(s.map(m => m.route.path)).toEqual(["/a"])
  })

  it("pop is a no-op at root (returns fresh array with same contents)", () => {
    const seed = RouterStack.seed("/a")
    const popped = RouterStack.pop(seed)
    expect(popped.map(m => m.route.path)).toEqual(["/a"])
  })

  it("replace swaps top-of-stack without changing depth", () => {
    const s = RouterStack.replace(
      RouterStack.push(RouterStack.seed("/a"), "/b"),
      "/c"
    )
    expect(s.map(m => m.route.path)).toEqual(["/a", "/c"])
  })

  it("reset seeds a brand-new stack regardless of previous state", () => {
    const s = RouterStack.reset("/b", { id: "1" })
    expect(s).toHaveLength(1)
    expect(s[0].route.path).toBe("/b")
    expect(s[0].params).toEqual({ id: "1" })
  })
})

describe("RouterStack.current", () => {
  it("returns undefined for an empty array (edge case — not produced by the API)", () => {
    expect(RouterStack.current([])).toBeUndefined()
  })

  it("returns the last element", () => {
    const s = RouterStack.push(RouterStack.seed("/a"), "/b")
    expect(RouterStack.current(s)?.route.path).toBe("/b")
  })
})
