import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  ClusterFiles,
  NodeRole,
  PidSources,
  StreamFrameType,
  StreamTopic,
  type ClusterState,
  type EventFrame,
  type NodeState,
  type ProcessLivenessEvent
} from "@wireio/debugging-shared"

import { DebuggingServer } from "@wireio/debugging-server"

import {
  collectFrames,
  connectStream,
  sendSubscribe
} from "./streamHelpers.js"

describe("ProcessLivenessStream over WS", () => {
  const tmpDir = Path.join(OS.tmpdir(), `wsProc-${Date.now()}`),
    nodeDir = Path.join(tmpDir, "data", "node_bios")
  let server: DebuggingServer
  let baseUrl: string

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

  it("emits an initial diff for newly-discovered sources", async () => {
    const ws = await connectStream(baseUrl)
    sendSubscribe(ws, {
      type: StreamFrameType.Subscribe,
      id: 1,
      topic: StreamTopic.ProcessLiveness,
      params: {}
    })
    const frames = await collectFrames(ws, 2, 8_000)
    expect(frames[0].type).toBe(StreamFrameType.Subscribed)
    expect(frames[1].type).toBe(StreamFrameType.Event)
    const event = (frames[1] as EventFrame<StreamTopic.ProcessLiveness>)
      .payload as ProcessLivenessEvent
    expect(event.setSnapshots.length).toBe(1)
    expect(event.setSnapshots[0].label).toBe("nodeop")
    expect(event.setSnapshots[0].alive).toBe(true)
    ws.close()
  }, 12_000)
})
