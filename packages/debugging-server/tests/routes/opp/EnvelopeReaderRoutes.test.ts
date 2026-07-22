import * as Fs from "node:fs"

import {
  ApiPaths,
  type LoadEnvelopeRecordsResponse
} from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope,
  type GetEnvelopeResponse,
  type ListEnvelopesResponse,
  type PutEnvelopeResponse
} from "@wireio/opp-typescript-models"

import { fixture } from "./envelopePersistenceTestSupport.js"
import {
  EnvelopeRouteHarness,
  makeRouteEnvelope,
  routePutParams
} from "./envelopeRouteTestSupport.js"

interface GetEnvelopeJson extends Omit<GetEnvelopeResponse, "envelopeData"> {
  readonly envelopeData: string
}

describe("tolerant OPP reader routes", () => {
  let harness: EnvelopeRouteHarness

  beforeEach(async () => {
    harness = await EnvelopeRouteHarness.start("opp-reader-routes")
  })

  afterEach(async () => {
    await harness.stop()
  })

  it("keeps List and Get tolerant for a data-only record", async () => {
    const storage = fixture(harness.storageDir, 401, 1)
    Fs.writeFileSync(storage.dataFile, storage.data)

    const listed = await harness.rpc<ListEnvelopesResponse>(
        ApiPaths.OPP.Methods.EnvelopeList,
        {}
      ),
      got = await harness.rpc<GetEnvelopeJson>(
        ApiPaths.OPP.Methods.EnvelopeGet,
        { key: storage.key }
      )

    expect(listed.body.result?.entries).toHaveLength(1)
    expect(listed.body.result?.entries[0]).toMatchObject({
      key: storage.key,
      batchOpNames: []
    })
    expect(got.body.result).toMatchObject({
      key: storage.key,
      checksum: "",
      batchOpNames: [],
      envelopeData: Buffer.from(storage.data).toString("base64")
    })
  })

  it("keeps LoadRecords metadata-led and skips incomplete or malformed pairs", async () => {
    const dataOnly = fixture(harness.storageDir, 402, 2),
      metadataOnly = fixture(harness.storageDir, 403, 3),
      malformed = fixture(harness.storageDir, 404, 4)
    Fs.writeFileSync(dataOnly.dataFile, dataOnly.data)
    Fs.writeFileSync(
      metadataOnly.metadataFile,
      DebugEnvelopeMetadataRecord.toBinary(
        DebugEnvelopeMetadataRecord.create({
          checksum: BigInt(`0x${metadataOnly.digest.slice(0, 12)}`),
          batchOpNames: ["batchop.metadata-only"]
        })
      )
    )
    Fs.writeFileSync(malformed.dataFile, malformed.data)
    Fs.writeFileSync(malformed.metadataFile, Buffer.from("malformed"))

    const loaded = await harness.rpc<LoadEnvelopeRecordsResponse>(
      ApiPaths.OPP.Methods.LoadRecords,
      {}
    )

    expect(loaded.body.result).toEqual({ records: [] })
  })

  it("reads one route-created pair through List, Get, and LoadRecords", async () => {
    const envelopeData = makeRouteEnvelope(405, 5),
      published = await harness.rpc<PutEnvelopeResponse>(
        ApiPaths.OPP.Methods.Envelope,
        routePutParams(envelopeData, "batchop.route")
      ),
      key = published.body.result?.key
    expect(key).toBeDefined()

    const listed = await harness.rpc<ListEnvelopesResponse>(
        ApiPaths.OPP.Methods.EnvelopeList,
        {}
      ),
      got = await harness.rpc<GetEnvelopeJson>(
        ApiPaths.OPP.Methods.EnvelopeGet,
        { key }
      ),
      loaded = await harness.rpc<LoadEnvelopeRecordsResponse>(
        ApiPaths.OPP.Methods.LoadRecords,
        {}
      )

    expect(listed.body.result?.entries[0]).toMatchObject({
      key,
      epochIndex: 405,
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      batchOpNames: ["batchop.route"]
    })
    expect(got.body.result).toMatchObject({
      key,
      epochIndex: 405,
      batchOpNames: ["batchop.route"]
    })
    expect(
      Envelope.fromBinary(
        Buffer.from(got.body.result?.envelopeData ?? "", "base64")
      ).epochIndex
    ).toBe(405)
    expect(loaded.body.result?.records).toHaveLength(1)
    expect(
      loaded.body.result?.records[0]?.envelopes[0]?.metadata.batchOpNames
    ).toEqual(["batchop.route"])
  })

  it("retains List filtering, ordering, and response fields", async () => {
    await Promise.all([
      harness.rpc<PutEnvelopeResponse>(
        ApiPaths.OPP.Methods.Envelope,
        routePutParams(makeRouteEnvelope(420, 1), "batchop.a")
      ),
      harness.rpc<PutEnvelopeResponse>(
        ApiPaths.OPP.Methods.Envelope,
        routePutParams(
          makeRouteEnvelope(410, 2),
          "batchop.b",
          DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
        )
      ),
      harness.rpc<PutEnvelopeResponse>(
        ApiPaths.OPP.Methods.Envelope,
        routePutParams(makeRouteEnvelope(410, 3), "batchop.c")
      )
    ])

    const all = await harness.rpc<ListEnvelopesResponse>(
        ApiPaths.OPP.Methods.EnvelopeList,
        {}
      ),
      epoch = await harness.rpc<ListEnvelopesResponse>(
        ApiPaths.OPP.Methods.EnvelopeList,
        { epochStart: 410, epochEnd: 410 }
      ),
      endpoint = await harness.rpc<ListEnvelopesResponse>(
        ApiPaths.OPP.Methods.EnvelopeList,
        {
          endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
        }
      ),
      entries = all.body.result?.entries ?? [],
      keys = entries.map(entry => entry.key)

    expect(all.body.result?.total).toBe(3)
    expect(keys).toEqual([...keys].sort())
    expect(epoch.body.result?.entries.map(entry => entry.epochIndex)).toEqual([
      410, 410
    ])
    expect(endpoint.body.result?.entries).toHaveLength(1)
    expect(endpoint.body.result?.entries[0]?.endpointsType).toBe(
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    )
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(
      [
        "batchOpNames",
        "checksum",
        "dataSize",
        "endpointsType",
        "epochIndex",
        "key",
        "timestamp"
      ].sort()
    )
  })

  it("retains Get JSON-RPC errors for missing keys", async () => {
    const response = await harness.rpc<GetEnvelopeJson>(
      ApiPaths.OPP.Methods.EnvelopeGet,
      { key: "00000000-FAKE-0000" }
    )

    expect(response.body.result).toBeUndefined()
    expect(response.body.error?.message).toContain("not found")
  })
})
