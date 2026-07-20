import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { ClusterFiles } from "@wireio/cluster-tool-shared"
import {
  ApiPaths,
  type GetClusterConfigResponse,
  type GetClusterStateResponse
} from "@wireio/debugging-shared"

import { DebuggingServer } from "@wireio/debugging-server"

/** JSON-RPC 2.0 error member carried by a failed response. */
interface RpcResponseError {
  /** JSON-RPC error code. */
  code: number
  /** Human-readable error description. */
  message: string
}

/** Parsed JSON-RPC 2.0 response envelope — the wire shape `JsonRPC.mount` writes. */
interface RpcResponseBody {
  jsonrpc: string
  id: number | null
  result?: unknown
  error?: RpcResponseError
}

/**
 * A structurally-complete `cluster-config.json` payload (dummy but schema-valid
 * values) — `ClusterAccess.getConfig` now validates it via
 * `ClusterConfigSchemaCodec`, so a partial fixture no longer round-trips.
 * `signatureProvider` / `externalOutposts` are schema-defaulted, so omitted.
 */
function fullConfig(clusterPath: string) {
  return {
    buildPath: "/x/build",
    clusterPath,
    dataPath: "/x/data",
    walletPath: "/x/wallet",
    producerCount: 1,
    nodeCount: 1,
    batchOperatorCount: 0,
    underwriterCount: 0,
    epochDurationSec: 60,
    warmupEpochs: 1,
    cooldownEpochs: 1,
    ethereumPath: "/eth",
    solanaPath: "/sol",
    bind: {
      kiod: { address: "127.0.0.1", port: 1 },
      nodeop: {
        address: "127.0.0.1",
        ports: {
          bios: { http: 2, p2p: 3 },
          producers: [],
          batch: [],
          underwriters: []
        }
      },
      anvil: { address: "127.0.0.1", port: 4 },
      solana: {
        address: "127.0.0.1",
        ports: {
          http: 5,
          faucet: 6,
          gossip: 7,
          dynamicRange: { first: 8, last: 9 }
        }
      },
      debuggingServer: { address: "127.0.0.1", port: 10 }
    },
    executables: {
      nodeop: "/x/nodeop",
      kiod: "/x/kiod",
      clio: "/x/clio",
      anvil: "/x/anvil",
      solanaTestValidator: "/x/solana-test-validator"
    },
    report: { path: "/x/reports", basename: "cluster-build", formats: [] },
    logging: {
      levels: { console: "info", file: "debug" },
      fileFormat: "jsonl"
    },
    requiredBatchOperatorCollateral: [],
    requiredUnderwriterCollateral: [],
    requiredProducerCollateral: [],
    underwriterCollateral: null,
    initialFinalizerKey: null
  }
}

/** A structurally-complete `cluster-state.json` payload (validated via `ClusterStateSchemaCodec`). */
function fullState(walletPath: string) {
  return {
    createdAt: new Date().toISOString(),
    nodes: [],
    walletPath,
    anvilStateFile: null,
    solanaLedgerPath: null,
    solanaIdlFile: null
  }
}

describe(`POST ${ApiPaths.Cluster.Endpoint}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `cluster-routes-${Date.now()}`)
  let server: DebuggingServer
  let baseUrl: string
  let nextId = 1

  function rpcCall(method: string, params: Record<string, unknown> = {}) {
    const id = nextId++
    return fetch(`${baseUrl}${ApiPaths.Cluster.Endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id })
    }).then(async r => ({
      status: r.status,
      body: (await r.json()) as RpcResponseBody,
      id
    }))
  }

  beforeAll(async () => {
    Fs.mkdirSync(tmpDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(tmpDir, ClusterFiles.ConfigFilename),
      JSON.stringify(fullConfig(tmpDir))
    )
    Fs.writeFileSync(
      Path.join(tmpDir, ClusterFiles.StateFilename),
      JSON.stringify(fullState(tmpDir))
    )
    server = await DebuggingServer.create({ clusterPath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns the cluster config", async () => {
    const { body } = await rpcCall(ApiPaths.Cluster.Methods.GetConfig)
    const result = body.result as GetClusterConfigResponse
    expect(result.clusterPath).toBe(tmpDir)
    expect(result.epochDurationSec).toBe(60)
  })

  it("returns the cluster state when the file exists", async () => {
    const { body } = await rpcCall(ApiPaths.Cluster.Methods.GetState)
    const result = body.result as GetClusterStateResponse
    expect(result.state).not.toBeNull()
  })
})

describe(`Cluster.GetState with no state file`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `cluster-no-state-${Date.now()}`)
  let server: DebuggingServer
  let baseUrl: string

  beforeAll(async () => {
    Fs.mkdirSync(tmpDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(tmpDir, ClusterFiles.ConfigFilename),
      JSON.stringify(fullConfig(tmpDir))
    )
    server = await DebuggingServer.create({ clusterPath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when cluster-state.json is missing", async () => {
    const resp = await fetch(`${baseUrl}${ApiPaths.Cluster.Endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: ApiPaths.Cluster.Methods.GetState,
        params: {},
        id: 1
      })
    })
    const body = (await resp.json()) as RpcResponseBody
    expect((body.result as GetClusterStateResponse).state).toBeNull()
  })
})
