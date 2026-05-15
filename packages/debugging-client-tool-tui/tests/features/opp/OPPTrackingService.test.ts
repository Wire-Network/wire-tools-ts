import { EnvelopeEventKind, StreamTopic } from "@wireio/debugging-shared"
import {
  DebuggingClientService,
  ReduxService,
  ServiceManager
} from "@wireio/debugging-client-tool-tui/services/index.js"
import { OPPTrackingService } from "@wireio/debugging-client-tool-tui/features/opp/OPPTrackingService.js"
import { store } from "@wireio/debugging-client-tool-tui/store/Store.js"
import { oppSlice } from "@wireio/debugging-client-tool-tui/store/opp/OPPSlice.js"
import { LoggingManager } from "@wireio/debugging-client-tool-tui/logging/LoggingManager.js"
import { Level } from "@wireio/shared"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"

import { MockDebuggingClient } from "../MockDebuggingClient.js"

const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), "opp-tracking-svc-"))

beforeAll(() => {
  LoggingManager.configure({ clusterPath: tmp, level: Level.fatal })
})

afterEach(() => {
  // Reset the OPP slice between tests via a no-op dispatch trick — calling
  // the slice's clear action via the OPPSlice export.
  store.dispatch(oppSlice.actions.clear())
})

describe("OPPTrackingService", () => {
  let client: MockDebuggingClient
  let manager: ServiceManager

  beforeEach(async () => {
    await ServiceManager.resetForTests()
    client = new MockDebuggingClient()
    manager = ServiceManager.get()
    manager.register(ReduxService)
    manager.registerInstance(new DebuggingClientService(client as any))
    manager.register(OPPTrackingService)
    await manager.boot()
  })

  afterEach(async () => {
    await ServiceManager.resetForTests()
  })

  it("dispatches hydrate(records) for the initial burst", async () => {
    client.emit(StreamTopic.EnvelopeWatch, {
      kind: EnvelopeEventKind.Hydrated,
      epoch: 1,
      record: {
        checksum: "deadbeef",
        endpointsType: 1 as any,
        envelope: {} as any,
        metadata: {} as any,
        receivedAt: 1
      }
    })
    await new Promise(r => setTimeout(r, 600))
    expect(store.getState().opp.epochs[1]?.envelopes.length).toBe(1)
    expect(store.getState().opp.epochs[1]?.envelopes[0].checksum).toBe(
      "deadbeef"
    )
  })

  it("dispatches appendEnvelope on Added events after hydration", async () => {
    client.emit(StreamTopic.EnvelopeWatch, {
      kind: EnvelopeEventKind.Hydrated,
      epoch: 1,
      record: {
        checksum: "h1",
        endpointsType: 1 as any,
        envelope: {} as any,
        metadata: {} as any,
        receivedAt: 1
      }
    })
    await new Promise(r => setTimeout(r, 600))
    client.emit(StreamTopic.EnvelopeWatch, {
      kind: EnvelopeEventKind.Added,
      epoch: 2,
      record: {
        checksum: "a1",
        endpointsType: 2 as any,
        envelope: {} as any,
        metadata: {} as any,
        receivedAt: 2
      }
    })
    expect(store.getState().opp.epochs[2]?.envelopes.length).toBe(1)
  })
})
