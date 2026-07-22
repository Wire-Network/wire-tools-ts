import * as Fs from "node:fs"

import {
  ApiPaths,
  EnvelopeEventKind,
  StreamFrameType,
  StreamTopic
} from "@wireio/debugging-shared"
import { type PutEnvelopeResponse } from "@wireio/opp-typescript-models"

import {
  collectFrames,
  connectStream,
  sendSubscribe
} from "../../streams/streamHelpers.js"
import { fixture } from "./envelopePersistenceTestSupport.js"
import {
  EnvelopeRouteHarness,
  makeRouteEnvelope,
  routePutParams
} from "./envelopeRouteTestSupport.js"

describe("route-created envelope watch visibility", () => {
  let harness: EnvelopeRouteHarness

  beforeEach(async () => {
    harness = await EnvelopeRouteHarness.start("opp-watch-route")
  })

  afterEach(async () => {
    await harness.stop()
  })

  it("hydrates the route-created pair while skipping incomplete pairs", async () => {
    const dataOnly = fixture(harness.storageDir, 501, 1),
      malformed = fixture(harness.storageDir, 502, 2)
    Fs.writeFileSync(dataOnly.dataFile, dataOnly.data)
    Fs.writeFileSync(malformed.dataFile, malformed.data)
    Fs.writeFileSync(malformed.metadataFile, Buffer.from("malformed"))

    const published = await harness.rpc<PutEnvelopeResponse>(
      ApiPaths.OPP.Methods.Envelope,
      routePutParams(makeRouteEnvelope(503, 3), "batchop.route-watch")
    )
    expect(published.status).toBe(200)

    const ws = await connectStream(harness.baseUrl)
    sendSubscribe(ws, {
      type: StreamFrameType.Subscribe,
      id: 1,
      topic: StreamTopic.EnvelopeWatch,
      params: {}
    })
    const frames = await collectFrames(ws, 2)
    ws.close()

    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ type: StreamFrameType.Subscribed })
    expect(frames[1]).toMatchObject({
      type: StreamFrameType.Event,
      payload: {
        kind: EnvelopeEventKind.Hydrated,
        epoch: 503,
        record: {
          metadata: { batchOpNames: ["batchop.route-watch"] }
        }
      }
    })
  })
})
