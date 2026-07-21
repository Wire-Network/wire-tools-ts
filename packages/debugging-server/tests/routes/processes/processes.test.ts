import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  ClusterFiles,
  ClusterStateNodeRole,
  type ClusterState,
  type ClusterStateNode
} from "@wireio/cluster-tool-shared"
import {
  ApiPaths,
  PidSources,
  type GetProcessLivenessResponse,
  type ListProcessesResponse
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

describe(`POST ${ApiPaths.Processes.Endpoint}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `process-routes-${Date.now()}`),
    nodeDir = Path.join(tmpDir, "data", "node_bios")
  let server: DebuggingServer
  let baseUrl: string
  let nextId = 1

  function rpcCall(method: string, params: Record<string, unknown> = {}) {
    const id = nextId++
    return fetch(`${baseUrl}${ApiPaths.Processes.Endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id })
    }).then(async r => ({
      status: r.status,
      body: (await r.json()) as RpcResponseBody
    }))
  }

  beforeAll(async () => {
    Fs.mkdirSync(nodeDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(nodeDir, `nodeop${PidSources.PidExt}`),
      String(process.pid)
    )
    const node: ClusterStateNode = {
      name: PidSources.BiosNodeId,
      role: ClusterStateNodeRole.bios,
      nodePath: nodeDir,
      ports: { http: 0, p2p: 0 },
      producers: [],
      batchOperatorLabel: null,
      underwriterLabel: null
    }
    const state: ClusterState = {
      createdAt: new Date().toISOString(),
      nodes: [node],
      walletPath: "",
      anvilStateFile: "",
      solanaLedgerPath: "",
      solanaIdlFile: null
    }
    Fs.writeFileSync(
      Path.join(tmpDir, ClusterFiles.ConfigFilename),
      JSON.stringify({ clusterPath: tmpDir })
    )
    Fs.writeFileSync(
      Path.join(tmpDir, ClusterFiles.StateFilename),
      JSON.stringify(state)
    )
    server = await DebuggingServer.create({ clusterPath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("List returns the bios pid source", async () => {
    const { body } = await rpcCall(ApiPaths.Processes.Methods.List)
    const result = body.result as ListProcessesResponse
    expect(result.sources.length).toBe(1)
    expect(result.sources[0].label).toBe("nodeop")
  })

  it("GetLiveness reports the running process as alive", async () => {
    const { body } = await rpcCall(ApiPaths.Processes.Methods.GetLiveness, {
      labels: ["nodeop"]
    })
    const result = body.result as GetProcessLivenessResponse
    expect(result.snapshots.length).toBe(1)
    expect(result.snapshots[0].pid).toBe(process.pid)
    expect(result.snapshots[0].alive).toBe(true)
  })

  it("GetLiveness with empty labels probes every source", async () => {
    const { body } = await rpcCall(ApiPaths.Processes.Methods.GetLiveness, {
      labels: []
    })
    const result = body.result as GetProcessLivenessResponse
    expect(result.snapshots.length).toBe(1)
  })
})
