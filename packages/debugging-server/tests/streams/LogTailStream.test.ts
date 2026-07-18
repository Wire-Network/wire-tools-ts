import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { ClusterFiles } from "@wireio/cluster-tool-shared"
import {
  StreamFrameType,
  StreamTopic,
  type EventFrame,
  type LogTailEvent,
  type SubscribedFrame
} from "@wireio/debugging-shared"

import { DebuggingServer } from "@wireio/debugging-server"

import { collectFrames, connectStream, sendSubscribe } from "./streamHelpers.js"

describe("LogTailStream over WS", () => {
  const tmpDir = Path.join(OS.tmpdir(), `wsLogTail-${Date.now()}`),
    logFile = Path.join(tmpDir, "data", "node_bios", "logs", "log.txt")
  let server: DebuggingServer
  let baseUrl: string

  beforeAll(async () => {
    Fs.mkdirSync(Path.dirname(logFile), { recursive: true })
    Fs.writeFileSync(logFile, "alpha\nbeta\n")
    Fs.writeFileSync(
      Path.join(tmpDir, ClusterFiles.ConfigFilename),
      JSON.stringify({ clusterPath: tmpDir })
    )
    server = await DebuggingServer.create({ clusterPath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("emits Subscribed then a baseline Event frame", async () => {
    const ws = await connectStream(baseUrl)
    sendSubscribe(ws, {
      type: StreamFrameType.Subscribe,
      id: 1,
      topic: StreamTopic.LogTail,
      params: { path: logFile }
    })
    const frames = await collectFrames(ws, 2)
    expect(frames[0].type).toBe(StreamFrameType.Subscribed)
    expect((frames[0] as SubscribedFrame).id).toBe(1)
    expect(frames[1].type).toBe(StreamFrameType.Event)
    const event = (frames[1] as EventFrame<StreamTopic.LogTail>).payload
    expect(event.totalLines).toBe(2)
    ws.close()
  }, 10_000)

  it("emits an Event when the file grows", async () => {
    const ws = await connectStream(baseUrl)
    sendSubscribe(ws, {
      type: StreamFrameType.Subscribe,
      id: 2,
      topic: StreamTopic.LogTail,
      params: { path: logFile }
    })
    // Drain initial Subscribed + baseline Event
    await collectFrames(ws, 2)
    Fs.appendFileSync(logFile, "gamma\n")
    const [growthFrame] = await collectFrames(ws, 1)
    expect(growthFrame.type).toBe(StreamFrameType.Event)
    const ev = (growthFrame as EventFrame<StreamTopic.LogTail>)
      .payload as LogTailEvent
    expect(ev.lines).toContain("gamma")
    ws.close()
  }, 10_000)
})
