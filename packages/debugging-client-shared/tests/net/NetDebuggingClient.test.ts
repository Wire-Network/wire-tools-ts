import * as Fs from "node:fs"

import {
  ClosedReason,
  EnvelopeEventKind,
  PidSources,
  StreamTopic,
  type EnvelopeEvent,
  type LogTailEvent,
  type ProcessLivenessEvent
} from "@wireio/debugging-shared"
import {
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"

import { DebuggingServer } from "@wireio/debugging-server"

import {
  LocalFileDebuggingClient,
  NetDebuggingClient
} from "@wireio/debugging-client-shared"

import { makeFixtureCluster, type FixtureCluster } from "../local/fixtureCluster.js"

function makeEnvelopeBase64(epochIndex: number): string {
  const bytes = Envelope.toBinary(
    Envelope.create({
      epochIndex,
      epochTimestamp: BigInt(Date.now()),
      envelopeHash: new Uint8Array(32),
      previousEnvelopeHash: new Uint8Array(32),
      merkle: new Uint8Array(32),
      startMessageId: new Uint8Array(32),
      endMessageId: new Uint8Array(32),
      messages: []
    })
  )
  return Buffer.from(bytes).toString("base64")
}

describe("NetDebuggingClient", () => {
  let fixture: FixtureCluster
  let server: DebuggingServer
  let local: LocalFileDebuggingClient
  let client: NetDebuggingClient
  let baseUrl: string

  beforeEach(async () => {
    fixture = makeFixtureCluster()
    server = await DebuggingServer.create({
      clusterPath: fixture.clusterPath,
      port: 0
    })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
    // The local client serves as a writer for OPP envelopes during tests
    // (the production write path is the sysio plugin; the local client
    // exposes putEnvelope as a test-friendly equivalent).
    local = await LocalFileDebuggingClient.create({
      clusterPath: fixture.clusterPath
    })
    client = await NetDebuggingClient.create({ baseUrl })
    await client.connect()
  })

  afterEach(async () => {
    await client.disconnect()
    await local.disconnect()
    await server.stop()
    fixture.cleanup()
  })

  describe("create()", () => {
    it("rejects when the server isn't reachable", async () => {
      await expect(
        NetDebuggingClient.create({ baseUrl: "http://127.0.0.1:1" })
      ).rejects.toThrow()
    })
  })

  describe("getClusterConfig / getClusterState", () => {
    it("returns the cluster config", async () => {
      const cfg = await client.getClusterConfig()
      expect(cfg.clusterPath).toBe(fixture.clusterPath)
    })

    it("returns the cluster state when present", async () => {
      const state = await client.getClusterState()
      expect(state).not.toBeNull()
      expect(state!.nodes.length).toBe(1)
    })
  })

  describe("listProcessSources / getProcessLiveness", () => {
    it("lists fixture sources", async () => {
      fixture.writePid("data/node_bios", "nodeop", process.pid)
      const sources = await client.listProcessSources()
      expect(sources.some(s => s.label === "nodeop")).toBe(true)
    })

    it("reports the running process as alive", async () => {
      fixture.writePid("data/node_bios", "nodeop", process.pid)
      const snaps = await client.getProcessLiveness(["nodeop"])
      expect(snaps[0].alive).toBe(true)
      expect(snaps[0].pid).toBe(process.pid)
    })
  })

  describe("getLogStat / readLogWindow", () => {
    it("returns counters and a window", async () => {
      const path = fixture.writeLog(
        `data/node_bios/${PidSources.LogsSubdir}`,
        "log_20260508.log",
        "alpha\nbeta\ngamma\n"
      )
      const stat = await client.getLogStat(path)
      expect(stat.totalLines).toBe(3)
      const lines = await client.readLogWindow({
        path,
        fromLine: 0,
        count: 3
      })
      expect(lines).toEqual(["alpha", "beta", "gamma"])
    })

    it("rejects path-traversal", async () => {
      await expect(client.getLogStat("/etc/passwd")).rejects.toThrow(
        /Path traversal rejected/
      )
    })
  })

  describe("OPP envelope list / get", () => {
    it("round-trips a stored envelope through HTTP JSON-RPC", async () => {
      // Seed via the local client's putEnvelope (acts as a stand-in
      // for the sysio plugin in tests).
      const put = await local.putEnvelope({
        batchOpName: "batchop.a",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeData: Buffer.from(makeEnvelopeBase64(7), "base64")
      })

      const list = await client.listEnvelopes({
        epochStart: 0,
        epochEnd: 0,
        endpointsType: DebugOutpostEndpointsType.UNKNOWN,
        timestampStart: 0n,
        timestampEnd: 0n
      })
      expect(list.total).toBe(1)
      expect(list.entries[0].epochIndex).toBe(7)

      const got = await client.getEnvelope(put.key)
      expect(got.epochIndex).toBe(7)
      expect(got.endpointsType).toBe(
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
      )
      expect(got.batchOpNames).toEqual(["batchop.a"])
    })
  })

  describe("subscribe(LogTail) over WS", () => {
    it("emits appended lines", async () => {
      const logRel = `data/node_bios/${PidSources.LogsSubdir}`,
        path = fixture.writeLog(logRel, "tail.log", "alpha\nbeta\n")
      const events: LogTailEvent[] = []
      const sub = await client.subscribe(StreamTopic.LogTail, { path })
      sub.on("event", e => events.push(e))
      // wait for baseline event
      await new Promise(r => setTimeout(r, 250))
      fixture.appendLog(logRel, "tail.log", "gamma\n")
      await new Promise(r => setTimeout(r, 500))
      sub.close(ClosedReason.ClientRequested)
      const all = events.flatMap(e => e.lines)
      expect(all).toContain("gamma")
    }, 10_000)
  })

  describe("subscribe(EnvelopeWatch) over WS", () => {
    it("emits hydrated then added", async () => {
      // Seed before subscribe
      await local.putEnvelope({
        batchOpName: "batchop.a",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeData: Buffer.from(makeEnvelopeBase64(1), "base64")
      })
      const events: EnvelopeEvent[] = []
      const sub = await client.subscribe(StreamTopic.EnvelopeWatch, {})
      sub.on("event", e => events.push(e))
      await new Promise(r => setTimeout(r, 300))
      // Add a new envelope post-subscription
      await local.putEnvelope({
        batchOpName: "batchop.b",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        envelopeData: Buffer.from(makeEnvelopeBase64(2), "base64")
      })
      await new Promise(r => setTimeout(r, 600))
      sub.close(ClosedReason.ClientRequested)
      const hydrated = events
        .filter(e => e.kind === EnvelopeEventKind.Hydrated)
        .map(e => e.epoch)
      expect(hydrated).toContain(1)
    }, 10_000)
  })

  describe("subscribe(ProcessLiveness) over WS", () => {
    it("emits a diff for newly-discovered sources", async () => {
      const events: ProcessLivenessEvent[] = []
      const sub = await client.subscribe(StreamTopic.ProcessLiveness, {})
      sub.on("event", e => events.push(e))
      fixture.writePid("data/node_bios", "nodeop", process.pid)
      // ProcessLivenessStream poll cadence is 5s; allow generous time
      await new Promise(r => setTimeout(r, 6_000))
      sub.close(ClosedReason.ClientRequested)
      const allLabels = events.flatMap(e =>
        e.setSnapshots.map(s => s.label)
      )
      expect(allLabels).toContain("nodeop")
    }, 15_000)
  })
})
