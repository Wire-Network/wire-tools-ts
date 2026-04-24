import React from "react"
import {
  RouterContext,
  RouterProvider,
  useRouter
} from "@wire-e2e-tests/debugging-client-tool-tui/router/RouterContext.js"
import { RouteRegistry } from "@wire-e2e-tests/debugging-client-tool-tui/router/RouteRegistry.js"
import type { Route } from "@wire-e2e-tests/debugging-client-tool-tui/router/RouteTypes.js"

function mkRoute(path: string): Route {
  return {
    path,
    featureId: "t",
    name: path,
    component: () => React.createElement("span"),
    cyclable: true
  }
}

beforeEach(() => {
  RouteRegistry._resetForTests()
  RouteRegistry.register(mkRoute("/a"))
  RouteRegistry.register(mkRoute("/b"))
})

describe("RouterContext", () => {
  it("exports a Context with null default (so useRouter can throw cleanly)", () => {
    const ctx: any = RouterContext
    expect(ctx._currentValue).toBeNull()
  })
})

describe("RouterProvider", () => {
  it("is a React function component", () => {
    expect(typeof RouterProvider).toBe("function")
  })

  // Stack-transition coverage lives in RouterStack.test.ts — RouterProvider is
  // the thin React wrapper. Rendering it requires a full React renderer, which
  // isn't a dep here; the pure helpers give us the behavioral coverage.
})

/**
 * Drive useRouter without a renderer by mocking React.useContext. This tests
 * the hook's access + error paths; the stack mutations themselves are covered
 * in RouterStack.test.ts.
 */
describe("useRouter", () => {
  it("returns the context value when one is set", () => {
    const fakeApi = {
      stack: [],
      current: undefined,
      canGoBack: false,
      push: jest.fn(),
      replace: jest.fn(),
      pop: jest.fn(),
      reset: jest.fn()
    }
    const spy = jest.spyOn(React, "useContext").mockImplementation(() => fakeApi)
    try {
      expect(useRouter()).toBe(fakeApi)
    } finally {
      spy.mockRestore()
    }
  })

  it("throws when no provider is mounted (context returns null)", () => {
    const spy = jest.spyOn(React, "useContext").mockImplementation(() => null)
    try {
      expect(() => useRouter()).toThrow(/outside a RouterProvider/)
    } finally {
      spy.mockRestore()
    }
  })
})
