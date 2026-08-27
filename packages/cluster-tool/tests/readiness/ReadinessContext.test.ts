import {
  createReadinessConfig,
  ReadinessClient
} from "@wireio/cluster-tool/readiness"

const config = createReadinessConfig({
  wireRpc: "https://wire.example",
  ethereumRpc: "https://ethereum.example",
  solanaRpc: "https://solana.example",
  timeoutMs: 1_000,
  report: { path: "/tmp", basename: "readiness", formats: [] }
})

describe("ReadinessClient", () => {
  it("performs read-only JSON-RPC calls through the injected fetch", async () => {
    const request = jest.fn(
        async () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7a69" }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
      ),
      client = new ReadinessClient(config, request)

    await expect(
      client.jsonRpc<string>(config.endpoints.ethereumRpc, "eth_chainId", [])
    ).resolves.toBe("0x7a69")
    expect(request).toHaveBeenCalledWith(
      "https://ethereum.example",
      expect.objectContaining({ method: "POST" })
    )
  })

  it("surfaces JSON-RPC errors without inventing a result", async () => {
    const request = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { message: "denied" }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      ),
      client = new ReadinessClient(config, request)
    await expect(
      client.jsonRpc(config.endpoints.solanaRpc, "getHealth", [])
    ).rejects.toThrow("getHealth failed: denied")
  })
})
