import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"
import { ClusterFiles } from "@wireio/cluster-tool-shared"
import { createHash } from "node:crypto"

import {
  EnvelopeEventKind,
  StreamFrameType,
  StreamTopic,
  endpointsTypeToKey,
  oppDebuggingPath,
  type EnvelopeEvent,
  type EventFrame
} from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"

import { DebuggingServer } from "@wireio/debugging-server"

import { collectFrames, connectStream, sendSubscribe } from "./streamHelpers.js"

const ChecksumHexChars = 16,
  EpochIndexPadWidth = 8

function writeEnvelopePair(
  storageDir: string,
  epochIndex: number,
  endpointsType: DebugOutpostEndpointsType,
  batchOpName: string
): string {
  // Note: per the v6 OPP-proto trim, `merkle` / `start_message_id` /
  // `end_message_id` were removed from `Envelope`. Test fixtures only
  // populate the fields the wire format still carries.
  const envelope = Envelope.create({
    epochIndex,
    epochTimestamp: BigInt(Date.now()),
    envelopeHash: new Uint8Array(32),
    previousEnvelopeHash: new Uint8Array(32),
    messages: []
  })
  const bytes = Envelope.toBinary(envelope),
    checksum = createHash("sha256")
      .update(Buffer.from(bytes))
      .digest("hex")
      .substring(0, ChecksumHexChars),
    endpointsKey = endpointsTypeToKey(endpointsType),
    epochStr = String(epochIndex).padStart(EpochIndexPadWidth, "0"),
    baseKey = `${epochStr}-${endpointsKey}-${checksum}`
  // Write `.data` first (matches server geometry), then `.metadata`.
  Fs.writeFileSync(Path.join(storageDir, `${baseKey}.data`), Buffer.from(bytes))
  const meta = DebugEnvelopeMetadataRecord.create({
    checksum: BigInt(`0x${checksum.substring(0, 12)}`),
    batchOpNames: [batchOpName]
  })
  Fs.writeFileSync(
    Path.join(storageDir, `${baseKey}.metadata`),
    DebugEnvelopeMetadataRecord.toBinary(meta)
  )
  return baseKey
}

describe("EnvelopeWatchStream over WS", () => {
  const tmpDir = Path.join(OS.tmpdir(), `wsEnvelope-${Date.now()}`)
  let server: DebuggingServer
  let baseUrl: string

  beforeAll(async () => {
    Fs.mkdirSync(tmpDir, { recursive: true })
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

  it("emits Hydrated for pre-existing pairs and Added for new ones", async () => {
    const storageDir = oppDebuggingPath(tmpDir)
    Fs.mkdirSync(storageDir, { recursive: true })
    writeEnvelopePair(
      storageDir,
      11,
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      "batchop.a"
    )

    const ws = await connectStream(baseUrl)
    sendSubscribe(ws, {
      type: StreamFrameType.Subscribe,
      id: 1,
      topic: StreamTopic.EnvelopeWatch,
      params: {}
    })

    const initial = await collectFrames(ws, 2)
    // Subscribed then a Hydrated event
    expect(initial[0].type).toBe(StreamFrameType.Subscribed)
    const hydrated = (initial[1] as EventFrame<StreamTopic.EnvelopeWatch>)
      .payload as EnvelopeEvent
    expect(hydrated.kind).toBe(EnvelopeEventKind.Hydrated)
    expect(hydrated.epoch).toBe(11)

    // Drop a new pair; should fire an Added event
    writeEnvelopePair(
      storageDir,
      12,
      DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
      "batchop.b"
    )
    const [addedFrame] = await collectFrames(ws, 1)
    const added = (addedFrame as EventFrame<StreamTopic.EnvelopeWatch>)
      .payload as EnvelopeEvent
    expect(added.kind).toBe(EnvelopeEventKind.Added)
    expect(added.epoch).toBe(12)
    ws.close()
  }, 10_000)
})
