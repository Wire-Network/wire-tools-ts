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
  PidSources,
  StreamFrameType,
  StreamTopic,
  type EventFrame,
  type ProcessLivenessEvent
} from "@wireio/debugging-shared"

import { DebuggingServer } from "@wireio/debugging-server"

import { collectFrames, connectStream, sendSubscribe } from "./streamHelpers.js"

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
    const node: ClusterStateNode = {
      name: PidSources.BiosNodeId,
      role: ClusterStateNodeRole.bios,
      nodePath: nodeDir,
      ports: { http: 0, p2p: 0 },
      producers: [],
      batchOperatorAccount: null,
      underwriterAccount: null
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
