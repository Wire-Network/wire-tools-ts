import { ReadinessClient } from "@wireio/cluster-tool/clients/readiness"
import { createReadinessConfig } from "@wireio/cluster-tool/config"
import { StepExtraRecorder } from "@wireio/cluster-tool/report"

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

  it("records WIRE API reads through the native Step recorder", async () => {
    const request = jest.fn(
        async () =>
          new Response(JSON.stringify({ head_block_num: 7 }), { status: 200 })
      ),
      client = new ReadinessClient(config, request),
      recorder = new StepExtraRecorder()
    await StepExtraRecorder.runWith(recorder, () =>
      client.wireApi.v1Provider.call({
        path: "/v1/chain/get_table_rows",
        params: { code: "sysio.opreg", table: "operators" }
      })
    )
    expect(recorder.calls).toEqual([
      {
        client: "wire",
        kind: "rpc",
        path: "/v1/chain/get_table_rows",
        params: { code: "sysio.opreg", table: "operators" }
      }
    ])
  })

  it("redacts credentials and query parameters from request failures", async () => {
    const endpoint =
        "https://operator:secret@wire.example/health?token=hidden#fragment",
      request = jest.fn(async () => {
        throw new Error(`offline while requesting ${endpoint}`)
      }),
      client = new ReadinessClient(config, request),
      error = await client.fetchJson(endpoint).then(
        () => new Error("request unexpectedly succeeded"),
        reason =>
          reason instanceof Error ? reason : new Error(String(reason))
      )
    expect(error.message).toContain(
      "Request failed: https://wire.example/health"
    )
    expect(error.stack).not.toContain("secret")
    expect(error.stack).not.toContain("hidden")
  })
})
