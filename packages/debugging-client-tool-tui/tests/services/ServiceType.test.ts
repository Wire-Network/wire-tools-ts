import { asServiceType } from "@wireio/debugging-client-tool-tui/services/ServiceType.js"
import type { Service } from "@wireio/debugging-client-tool-tui/services/Service.js"

class Stub implements Service {
  static readonly id = "stub"
  static readonly dependsOn: readonly string[] = []
  async init(): Promise<Service> {
    return this
  }
  async start(): Promise<Service> {
    return this
  }
  async stop(): Promise<Service> {
    return this
  }
}

describe("asServiceType", () => {
  it("returns the passed ctor unchanged (identity for type-assertion side effect)", () => {
    expect(asServiceType(Stub)).toBe(Stub)
  })

  it("preserves id + dependsOn statics", () => {
    const typed = asServiceType(Stub)
    expect(typed.id).toBe("stub")
    expect(typed.dependsOn).toEqual([])
  })
})
