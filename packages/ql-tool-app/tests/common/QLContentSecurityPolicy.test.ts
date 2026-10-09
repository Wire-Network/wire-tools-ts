import { QLContentSecurityPolicy } from "@wireio/ql-tool-app/common"

/** Parse a policy into directive → sources. */
function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(";").map(part => {
      const [name, ...sources] = part.trim().split(/\s+/)
      return [name, sources.join(" ")]
    })
  )
}

describe("QLContentSecurityPolicy", () => {
  it("Production locks scripts, workers and connections to self", () => {
    const production = directives(QLContentSecurityPolicy.Production)
    expect(production.get("script-src")).toBe("'self'")
    expect(production.get("worker-src")).toBe("'self' blob:")
    expect(production.get("connect-src")).toBe("'self'")
    expect(production.get("object-src")).toBe("'none'")
    expect(QLContentSecurityPolicy.Production).not.toContain("unsafe-eval")
  })

  it("Production omits frame-ancestors (ignored in a meta tag); the header-only part carries it", () => {
    expect(directives(QLContentSecurityPolicy.Production).has("frame-ancestors")).toBe(false)
    expect(directives(QLContentSecurityPolicy.HeaderOnly).get("frame-ancestors")).toBe("'none'")
  })

  it("Development differs only by the HMR websocket in connect-src plus the header-only directives", () => {
    const production = directives(QLContentSecurityPolicy.Production),
      development = directives(QLContentSecurityPolicy.Development)
    expect(development.get("connect-src")).toBe("'self' ws://localhost:*")
    expect(development.get("frame-ancestors")).toBe("'none'")
    const unchanged = [...production.keys()].filter(name => name !== "connect-src")
    unchanged.forEach(name => expect(development.get(name)).toBe(production.get(name)))
    expect(development.size).toBe(production.size + 1)
  })

  it("DevelopmentMeta is the dev-server meta tag: the websocket, and no header-only directive", () => {
    const meta = directives(QLContentSecurityPolicy.DevelopmentMeta)
    expect(meta.get("connect-src")).toBe("'self' ws://localhost:*")
    expect(meta.has("frame-ancestors")).toBe(false)
    expect(QLContentSecurityPolicy.Development).toBe(`${QLContentSecurityPolicy.DevelopmentMeta}; ${QLContentSecurityPolicy.HeaderOnly}`)
  })
})
