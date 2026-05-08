import * as Fs from "node:fs"
import * as Path from "node:path"

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

import { LocalFileDebuggingClient } from "@wireio/debugging-client-shared"

import { makeFixtureCluster, type FixtureCluster } from "./fixtureCluster.js"

describe("LocalFileDebuggingClient", () => {
  let fixture: FixtureCluster
  let client: LocalFileDebuggingClient

  beforeEach(async () => {
    fixture = makeFixtureCluster()
    client = await LocalFileDebuggingClient.create({
      clusterPath: fixture.clusterPath
    })
    await client.connect()
  })

  afterEach(async () => {
    await client.disconnect()
    fixture.cleanup()
  })

  describe("create()", () => {
    it("throws when cluster-config.json is missing", async () => {
      const empty = Fs.mkdtempSync("/tmp/empty-")
      await expect(
        LocalFileDebuggingClient.create({ clusterPath: empty })
      ).rejects.toThrow(/cluster-config\.json not found/)
      Fs.rmSync(empty, { recursive: true, force: true })
    })
  })

  describe("getClusterConfig / getClusterState", () => {
    it("returns the on-disk config", async () => {
      const cfg = await client.getClusterConfig()
      expect(cfg.clusterPath).toBe(fixture.clusterPath)
    })

    it("returns the on-disk state when present", async () => {
      const state = await client.getClusterState()
      expect(state).not.toBeNull()
      expect(state!.nodes.length).toBe(1)
    })

    it("returns null when state file is missing", async () => {
      Fs.rmSync(
        Path.join(fixture.clusterPath, "cluster-state.json"),
        { force: true }
      )
      expect(await client.getClusterState()).toBeNull()
    })
  })

  describe("listProcessSources / getProcessLiveness", () => {
    it("returns sources from the fixture state", async () => {
      fixture.writePid("data/node_bios", "nodeop", process.pid)
      const sources = await client.listProcessSources()
      const labels = sources.map(s => s.label).sort()
      expect(labels).toContain("nodeop")
    })

    it("reports alive when pid file points at the current process", async () => {
      fixture.writePid("data/node_bios", "nodeop", process.pid)
      const snaps = await client.getProcessLiveness(["nodeop"])
      expect(snaps.length).toBe(1)
      expect(snaps[0].alive).toBe(true)
      expect(snaps[0].pid).toBe(process.pid)
    })

    it("reports dead when pid file is bogus", async () => {
      fixture.writePid("data/node_bios", "nodeop", 99999999)
      const snaps = await client.getProcessLiveness(["nodeop"])
      expect(snaps[0].alive).toBe(false)
      expect(snaps[0].exitedAt).toBe(snaps[0].lastCheckedAt)
    })
  })

  describe("getLogStat / readLogWindow", () => {
    it("reports complete-line counts and reads windows", async () => {
      const logFile = fixture.writeLog(
        `data/node_bios/${PidSources.LogsSubdir}`,
        "log_20260508.log",
        "alpha\nbeta\ngamma\n"
      )
      const stat = await client.getLogStat(logFile)
      expect(stat.totalLines).toBe(3)
      const slice = await client.readLogWindow({
        path: logFile,
        fromLine: 1,
        count: 2
      })
      expect(slice).toEqual(["beta", "gamma"])
    })
  })

  describe("OPP envelope put / list / get", () => {
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

    it("round-trips a single envelope through put/list/get", async () => {
      const put = await client.putEnvelope({
        batchOpName: "batchop.a",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeData: Buffer.from(makeEnvelopeBase64(7), "base64")
      })
      expect(put.dataExisted).toBe(false)
      expect(put.batchOpNames).toEqual(["batchop.a"])

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

    it("filters list by epoch range", async () => {
      await client.putEnvelope({
        batchOpName: "batchop.a",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeData: Buffer.from(makeEnvelopeBase64(5), "base64")
      })
      await client.putEnvelope({
        batchOpName: "batchop.a",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeData: Buffer.from(makeEnvelopeBase64(15), "base64")
      })
      const list = await client.listEnvelopes({
        epochStart: 10,
        epochEnd: 0,
        endpointsType: DebugOutpostEndpointsType.UNKNOWN,
        timestampStart: 0n,
        timestampEnd: 0n
      })
      expect(list.entries.map(e => e.epochIndex)).toEqual([15])
    })

    it("getEnvelope rejects unknown keys", async () => {
      await expect(client.getEnvelope("missing-key")).rejects.toThrow(
        /Envelope not found/
      )
    })
  })

  describe("subscribe(LogTail)", () => {
    it("emits appended lines", async () => {
      const logRel = `data/node_bios/${PidSources.LogsSubdir}`,
        logFile = fixture.writeLog(logRel, "tail.log", "alpha\nbeta\n")
      const events: LogTailEvent[] = []
      const sub = await client.subscribe(StreamTopic.LogTail, { path: logFile })
      sub.on("event", e => events.push(e))
      // Initial emit (might be 0 lines or 2 lines; either fine)
      await new Promise(r =>
        setTimeout(r, LocalFileDebuggingClient.LogTailPollMs + 50)
      )
      fixture.appendLog(logRel, "tail.log", "gamma\n")
      await new Promise(r =>
        setTimeout(r, LocalFileDebuggingClient.LogTailPollMs * 2 + 50)
      )
      sub.close(ClosedReason.ClientRequested)
      const flatLines = events.flatMap(e => e.lines)
      expect(flatLines).toContain("gamma")
    })
  })

  describe("subscribe(ProcessLiveness)", () => {
    it("emits a diff for newly-discovered sources", async () => {
      const events: ProcessLivenessEvent[] = []
      const sub = await client.subscribe(StreamTopic.ProcessLiveness, {})
      sub.on("event", e => events.push(e))
      fixture.writePid("data/node_bios", "nodeop", process.pid)
      await new Promise(r =>
        setTimeout(r, LocalFileDebuggingClient.ProcessLivenessPollMs + 200)
      )
      sub.close(ClosedReason.ClientRequested)
      const allLabels = events.flatMap(e =>
        e.setSnapshots.map(s => s.label)
      )
      expect(allLabels).toContain("nodeop")
    }, 10_000)
  })

  describe("subscribe(EnvelopeWatch)", () => {
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

    it("emits hydrated for pre-existing files and added for new ones", async () => {
      // Pre-seed before subscribing.
      await client.putEnvelope({
        batchOpName: "batchop.a",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeData: Buffer.from(makeEnvelopeBase64(1), "base64")
      })
      const events: EnvelopeEvent[] = []
      const sub = await client.subscribe(StreamTopic.EnvelopeWatch, {})
      sub.on("event", e => events.push(e))
      // Wait for initial hydrate dump.
      await new Promise(r => setTimeout(r, 200))
      // Add a new envelope post-subscription; Fs.watch should pick it up.
      await client.putEnvelope({
        batchOpName: "batchop.b",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
        envelopeData: Buffer.from(makeEnvelopeBase64(2), "base64")
      })
      await new Promise(r => setTimeout(r, 500))
      sub.close(ClosedReason.ClientRequested)
      expect(events.length).toBeGreaterThanOrEqual(1)
      const hydratedEpochs = events
        .filter(e => e.kind === EnvelopeEventKind.Hydrated)
        .map(e => e.epoch)
      expect(hydratedEpochs).toContain(1)
    }, 10_000)
  })
})
