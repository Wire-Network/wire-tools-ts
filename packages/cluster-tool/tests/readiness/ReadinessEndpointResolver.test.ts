import { ClusterReadinessEndpointSource } from "@wireio/cluster-tool-shared"
import { resolveReadinessConfig } from "@wireio/cluster-tool/readiness"
import { createReadinessDeploymentProfileFixture } from "./readinessProfileFixture.js"

const WireChainId = "a".repeat(64)

const wireInfo = {
  server_version: "0".repeat(40),
  chain_id: WireChainId,
  head_block_num: 10,
  last_irreversible_block_num: 9,
  last_irreversible_block_id: "0".repeat(64),
  head_block_id: "1".repeat(64),
  head_block_time: "2026-08-04T12:00:00.000",
  head_block_producer: "sysio",
  virtual_block_cpu_limit: "1000000",
  virtual_block_net_limit: "1000000",
  block_cpu_limit: "100000",
  block_net_limit: "100000"
}

const report = {
  path: "/tmp/readiness-test",
  basename: "readiness-test",
  formats: []
}

describe("resolveReadinessConfig", () => {
  it("resolves the complete network group from only a Wire chain id", async () => {
    const request = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      return Response.json(
        url.searchParams.has("chainId")
          ? [
              {
                networkType: "wire",
                rpcUrl: "https://wire.example",
                chainId: WireChainId,
                isActive: true
              }
            ]
          : [
              {
                networkType: "eth",
                rpcUrl: "https://ethereum.example",
                chainId: "31337",
                chainCode: "ETH",
                isActive: true
              },
              {
                networkType: "sol",
                rpcUrl: "https://solana.example",
                chainId: "genesis",
                chainCode: "SOL",
                isActive: true
              }
            ]
      )
    }) as unknown as typeof fetch

    const config = await resolveReadinessConfig(
      { wireChainId: WireChainId, report },
      request
    )
    expect(config.requestedWireChainId).toBe(WireChainId)
    expect(config.endpoints.map(endpoint => endpoint.url)).toEqual([
      "https://wire.example",
      "https://ethereum.example",
      "https://solana.example"
    ])
    expect(
      config.endpoints.every(endpoint => endpoint.source === "catalog")
    ).toBe(true)
  })

  it("discovers a network group from only the Wire RPC", async () => {
    const request = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/v1/chain/get_info")) {
        return Response.json(wireInfo)
      }
      if (url.searchParams.has("chainId")) {
        return Response.json([
          {
            networkType: "wire",
            rpcUrl: "https://wire.example",
            chainId: WireChainId,
            isActive: true
          }
        ])
      }
      return Response.json([
        {
          networkType: "eth",
          rpcUrl: "https://ethereum.example",
          chainId: "31337",
          chainCode: "ETH",
          isActive: true
        },
        {
          networkType: "sol",
          rpcUrl: "https://solana.example",
          chainId: "genesis",
          chainCode: "SOL",
          isActive: true
        }
      ])
    }) as unknown as typeof fetch

    const config = await resolveReadinessConfig(
      { wireRpc: "https://wire.example", report },
      request
    )
    expect(config.catalogErrors).toEqual([])
    expect(config.catalogRecordCount).toBe(3)
    expect(config.endpoints.map(endpoint => endpoint.url)).toEqual([
      "https://wire.example",
      "https://ethereum.example",
      "https://solana.example"
    ])
    expect(config.endpoints[0].source).toBe(
      ClusterReadinessEndpointSource.explicit
    )
  })

  it("retains explicit RPCs and reports failed identity discovery", async () => {
    const request = jest.fn(async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const config = await resolveReadinessConfig(
      {
        wireRpc: "https://wire.example",
        ethereumRpc: "https://ethereum.example",
        solanaRpc: "https://solana.example",
        report
      },
      request
    )
    expect(config.endpoints).toHaveLength(3)
    expect(config.catalogErrors.join(" ")).toMatch(/offline/)
  })

  it("retains an optional deployment profile alongside a Wire chain id", async () => {
    const profile = createReadinessDeploymentProfileFixture(),
      request = jest.fn(async () =>
        Response.json([])
      ) as unknown as typeof fetch,
      config = await resolveReadinessConfig(
        {
          wireChainId: profile.wire.chainId,
          outpostDeploymentProfile: profile,
          report
        },
        request
      )

    expect(config.requestedWireChainId).toBe(profile.wire.chainId)
    expect(config.outpostDeploymentProfile).toBe(profile)
  })

  it("rejects a Wire chain id that conflicts with the deployment profile", async () => {
    await expect(
      resolveReadinessConfig({
        wireChainId: "b".repeat(64),
        outpostDeploymentProfile: createReadinessDeploymentProfileFixture(),
        report
      })
    ).rejects.toThrow(/does not match deployment profile/)
  })

  it("requires a Wire identity source", async () => {
    await expect(resolveReadinessConfig({ report })).rejects.toThrow(
      /wireChainId or wireRpc/
    )
    await expect(
      resolveReadinessConfig({
        outpostDeploymentProfile: createReadinessDeploymentProfileFixture(),
        report
      })
    ).rejects.toThrow(/wireChainId or wireRpc/)
  })
})
