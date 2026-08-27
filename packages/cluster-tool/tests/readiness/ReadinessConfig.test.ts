import { createReadinessConfig } from "@wireio/cluster-tool/readiness"

const base = {
  wireRpc: "https://wire.example/",
  ethereumRpc: "https://ethereum.example/",
  solanaRpc: "https://solana.example/",
  expectedWireChainId: "A".repeat(64),
  report: { path: "/tmp", basename: "readiness", formats: [] }
}

describe("ReadinessConfig", () => {
  it("normalizes explicit endpoints and expected Wire identity", () => {
    const config = createReadinessConfig(base)
    expect(config.endpoints).toEqual({
      wireRpc: "https://wire.example",
      ethereumRpc: "https://ethereum.example",
      solanaRpc: "https://solana.example"
    })
    expect(config.expectedWireChainId).toBe("a".repeat(64))
    expect(config.observationMs).toBeGreaterThan(0)
    expect(config.timeoutMs).toBeGreaterThan(0)
  })

  it("rejects malformed identities and non-HTTP endpoints", () => {
    expect(() =>
      createReadinessConfig({ ...base, expectedWireChainId: "wrong" })
    ).toThrow("64-character hexadecimal")
    expect(() =>
      createReadinessConfig({ ...base, wireRpc: "file:///tmp/node" })
    ).toThrow("wireRpc must use http or https")
  })
})
