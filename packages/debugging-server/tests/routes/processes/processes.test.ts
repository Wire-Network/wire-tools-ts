import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  ApiPaths,
  ClusterFiles,
  NodeRole,
  PidSources,
  type ClusterState,
  type GetProcessLivenessResponse,
  type ListProcessesResponse,
  type NodeState
} from "@wireio/debugging-shared"

import { DebuggingServer } from "@wireio/debugging-server"

describe(`POST ${ApiPaths.Processes.Endpoint}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `process-routes-${Date.now()}`),
    nodeDir = Path.join(tmpDir, "data", "node_bios")
  let server: DebuggingServer
  let baseUrl: string
  let nextId = 1

  function rpcCall(method: string, params: any = {}) {
    const id = nextId++
    return fetch(`${baseUrl}${ApiPaths.Processes.Endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id })
    }).then(async r => ({
      status: r.status,
      body: (await r.json()) as any
    }))
  }

  beforeAll(async () => {
    Fs.mkdirSync(nodeDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(nodeDir, `nodeop${PidSources.PidExt}`),
      String(process.pid)
    )
    const node: NodeState = {
      nodeId: PidSources.BiosNodeId,
      host: "127.0.0.1",
      port: 0,
      dataPath: nodeDir,
      configPath: "",
      cmd: [],
      isProducer: true,
      producerName: null,
      role: NodeRole.Producer
    }
    const state: ClusterState = {
      pnodes: 1,
      totalNodes: 1,
      prodCount: 1,
      topo: "mesh",
      nodes: [node],
      batchOperatorNodes: [],
      underwriterNodes: [],
      anvilStatePath: "",
      solanaLedgerPath: "",
      walletPath: ""
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
