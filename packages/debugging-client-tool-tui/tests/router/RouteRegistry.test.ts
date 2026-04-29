import React from "react"
import { RouteRegistry } from "@wireio/debugging-client-tool-tui/router/RouteRegistry.js"
import type { Route } from "@wireio/debugging-client-tool-tui/router/RouteTypes.js"

function mkRoute(path: string, featureId: string, cyclable = true): Route {
  return {
    path,
    featureId,
    name: path,
    component: () => React.createElement("span"),
    cyclable
  }
}

beforeEach(() => {
  RouteRegistry._resetForTests()
})

describe("RouteRegistry.register", () => {
  it("stores a route by its path", () => {
    RouteRegistry.register(mkRoute("/a", "feat-a"))
    expect(RouteRegistry.find("/a")?.path).toBe("/a")
  })

  it("throws on duplicate path", () => {
    RouteRegistry.register(mkRoute("/a", "feat-a"))
    expect(() => RouteRegistry.register(mkRoute("/a", "feat-a"))).toThrow(
      /already registered/
    )
  })

  it("requires a non-empty path", () => {
    expect(() => RouteRegistry.register(mkRoute("", "feat-a"))).toThrow(
      /required/
    )
  })
})

describe("RouteRegistry.all / cyclable / findByFeatureId", () => {
  beforeEach(() => {
    RouteRegistry.register(mkRoute("/a", "feat-a", true))
    RouteRegistry.register(mkRoute("/b", "feat-b", true))
    RouteRegistry.register(mkRoute("/a/detail", "feat-a", false))
  })

  it("all returns every route in insertion order", () => {
    expect(RouteRegistry.all().map(r => r.path)).toEqual([
      "/a",
      "/b",
      "/a/detail"
    ])
  })

  it("cyclable excludes routes marked cyclable:false", () => {
    expect(RouteRegistry.cyclable().map(r => r.path)).toEqual(["/a", "/b"])
  })

  it("findByFeatureId returns all routes owned by a provider", () => {
    expect(RouteRegistry.findByFeatureId("feat-a").map(r => r.path)).toEqual([
      "/a",
      "/a/detail"
    ])
  })

  it("find returns undefined for unknown paths", () => {
    expect(RouteRegistry.find("/missing")).toBeUndefined()
  })
})
