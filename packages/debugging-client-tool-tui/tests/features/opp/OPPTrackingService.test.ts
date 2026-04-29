import Os from "node:os"
import Path from "node:path"
import Fs from "node:fs"
import Bluebird from "bluebird"
import { Level } from "@wireio/shared"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import { OPPTrackingService } from "@wireio/debugging-client-tool-tui/features/opp/OPPTrackingService.js"
import { ReduxService } from "@wireio/debugging-client-tool-tui/services/ReduxService.js"
import { ServiceId } from "@wireio/debugging-client-tool-tui/services/ServiceId.js"
import { ServiceManager } from "@wireio/debugging-client-tool-tui/services/ServiceManager.js"
import { clear } from "@wireio/debugging-client-tool-tui/store/opp/OPPSlice.js"
import { setCluster } from "@wireio/debugging-client-tool-tui/store/cluster/ClusterSlice.js"
import { store } from "@wireio/debugging-client-tool-tui/store/Store.js"

const logDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "opp-svc-"))

function padEpoch(n: number): string {
  return String(n).padStart(8, "0")
}

/** Build a minimal serialized envelope pair the server would have written. */
function writeEnvelope(
  dir: string,
  epoch: number,
  endpointsType: DebugOutpostEndpointsType,
  checksum: string,
  batchOpName: string
): string {
  const envelope = Envelope.create({ epochIndex: epoch } as any)
  const metadata = DebugEnvelopeMetadataRecord.create({
    checksum: BigInt(0),
    batchOpNames: [batchOpName]
  } as any)
  const key = `${padEpoch(epoch)}-${DebugOutpostEndpointsType[endpointsType]}-${checksum}`
  Fs.writeFileSync(
    Path.join(dir, `${key}.data`),
    Buffer.from(Envelope.toBinary(envelope))
  )
  Fs.writeFileSync(
    Path.join(dir, `${key}.metadata`),
    Buffer.from(DebugEnvelopeMetadataRecord.toBinary(metadata))
  )
  return key
}

beforeAll(() => {
  LoggingManager.configure({ clusterPath: logDir, level: Level.fatal })
})

beforeEach(async () => {
  await ServiceManager.resetForTests()
  store.dispatch(clear())
})

describe("OPPTrackingService static shape", () => {
  it("id/depends/category/subpath/ext constants", () => {
    expect(OPPTrackingService.id).toBe(ServiceId.OPPTracking)
    expect(OPPTrackingService.dependsOn).toEqual([ServiceId.Redux])
    expect(OPPTrackingService.Category).toBe("tui:opp-tracking")
    expect(OPPTrackingService.StorageSubpath).toBe("data/opp-debugging")
    expect(OPPTrackingService.DataExt).toBe(".data")
    expect(OPPTrackingService.MetadataExt).toBe(".metadata")
  })
})

describe("OPPTrackingService hydrate on start", () => {
  it("loads every pre-existing .data/.metadata pair into Redux", async () => {
    const clusterPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "opp-cluster-"))
    const storage = Path.join(clusterPath, OPPTrackingService.StorageSubpath)
    Fs.mkdirSync(storage, { recursive: true })
    writeEnvelope(
      storage,
      1,
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      "aaaaaaaaaaaaaaaa",
      "op-a"
    )
    writeEnvelope(
      storage,
      2,
      DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
      "bbbbbbbbbbbbbbbb",
      "op-b"
    )

    const sm = ServiceManager.get()
      .register(ReduxService)
      .register(OPPTrackingService)
    store.dispatch(
      setCluster({ path: clusterPath, config: {} as any, state: null })
    )
    await sm.boot()

    // Give the async start() a moment to dispatch hydrate.
    await Bluebird.delay(100)

    const opp = store.getState().opp
    expect(opp.epochOrder).toEqual(expect.arrayContaining([1, 2]))
    expect(opp.epochs[1]?.envelopes).toHaveLength(1)
    expect(opp.epochs[2]?.envelopes).toHaveLength(1)

    await sm.destroy()
  })
})
