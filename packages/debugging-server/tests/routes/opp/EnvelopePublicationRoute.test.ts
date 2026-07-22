import * as Fs from "node:fs"

import { JsonRPC } from "@wireio/debugging-server"
import { ApiPaths } from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  type PutEnvelopeResponse
} from "@wireio/opp-typescript-models"

import { fixture, metadata } from "./envelopePersistenceTestSupport.js"
import {
  EnvelopeRouteHarness,
  makeRouteEnvelope,
  routePutParams
} from "./envelopeRouteTestSupport.js"

describe("OPP envelope publication route", () => {
  let harness: EnvelopeRouteHarness

  beforeEach(async () => {
    harness = await EnvelopeRouteHarness.start("opp-publication-route")
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await harness.stop()
  })

  it("unions concurrent distinct and duplicate operator posts once", async () => {
    const envelopeData = makeRouteEnvelope(301),
      first = await harness.rpc<PutEnvelopeResponse>(
        ApiPaths.OPP.Methods.Envelope,
        routePutParams(envelopeData, "batchop.a")
      )
    expect(first.body.result?.batchOpNames).toEqual(["batchop.a"])

    const originalWriteFile = Fs.promises.writeFile.bind(Fs.promises)
    let releaseDuplicate = (): void => {
        throw new TypeError("duplicate metadata write did not arrive")
      },
      releaseDistinct = (): void => {
        throw new TypeError("distinct metadata write did not complete")
      }
    const duplicateArrived = new Promise<void>(resolve => {
        releaseDuplicate = resolve
      }),
      distinctCompleted = new Promise<void>(resolve => {
        releaseDistinct = resolve
      })

    jest
      .spyOn(Fs.promises, "writeFile")
      .mockImplementation(async (file, data, options) => {
        if (
          !String(file).endsWith(".metadata") ||
          !(data instanceof Uint8Array)
        ) {
          return originalWriteFile(file, data, options)
        }
        const names = DebugEnvelopeMetadataRecord.fromBinary(
          Buffer.from(data)
        ).batchOpNames
        if (names.includes("batchop.b")) {
          await duplicateArrived
          const result = await originalWriteFile(file, data, options)
          releaseDistinct()
          return result
        }
        releaseDuplicate()
        await distinctCompleted
        return originalWriteFile(file, data, options)
      })

    const [distinct, duplicate] = await Promise.all([
      harness.rpc<PutEnvelopeResponse>(
        ApiPaths.OPP.Methods.Envelope,
        routePutParams(envelopeData, "batchop.b")
      ),
      harness.rpc<PutEnvelopeResponse>(
        ApiPaths.OPP.Methods.Envelope,
        routePutParams(envelopeData, "batchop.a")
      )
    ])
    const finalMetadata = DebugEnvelopeMetadataRecord.fromBinary(
      Fs.readFileSync(
        `${harness.storageDir}/${first.body.result?.key}.metadata`
      )
    )

    expect(distinct.status).toBe(200)
    expect(duplicate.status).toBe(200)
    expect(distinct.body.result).toEqual({
      key: first.body.result?.key,
      dataExisted: true,
      batchOpNames: ["batchop.a", "batchop.b"]
    })
    expect(duplicate.body.result).toEqual({
      key: first.body.result?.key,
      dataExisted: true,
      batchOpNames: ["batchop.a", "batchop.b"]
    })
    expect(finalMetadata.batchOpNames).toEqual(["batchop.a", "batchop.b"])
    expect(new Set(finalMetadata.batchOpNames).size).toBe(2)
    expect(Fs.readdirSync(harness.storageDir).sort()).toEqual([
      `${first.body.result?.key}.data`,
      `${first.body.result?.key}.metadata`
    ])
  })

  it("repairs a valid data-only orphan and returns PutEnvelopeResponse", async () => {
    const storage = fixture(harness.storageDir, 302, 7)
    Fs.writeFileSync(storage.dataFile, storage.data)

    const response = await harness.rpc<PutEnvelopeResponse>(
      ApiPaths.OPP.Methods.Envelope,
      routePutParams(storage.data, "batchop.repair")
    )

    expect(response).toMatchObject({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: response.id,
        result: {
          key: storage.key,
          dataExisted: true,
          batchOpNames: ["batchop.repair"]
        }
      }
    })
    expect((await metadata(storage)).batchOpNames).toEqual(["batchop.repair"])
  })

  it("fails closed for UNKNOWN endpoints without creating files", async () => {
    const response = await harness.rpc<PutEnvelopeResponse>(
      ApiPaths.OPP.Methods.Envelope,
      routePutParams(
        makeRouteEnvelope(303),
        "batchop.invalid",
        DebugOutpostEndpointsType.UNKNOWN
      )
    )

    expect(response.status).toBe(200)
    expect(response.body.result).toBeUndefined()
    expect(response.body.error?.code).toBe(JsonRPC.ErrorCode.INTERNAL_ERROR)
    expect(Fs.readdirSync(harness.storageDir)).toEqual([])
  })

  it("maps persisted integrity failures to JSON-RPC without metadata", async () => {
    const storage = fixture(harness.storageDir, 304, 9)
    Fs.writeFileSync(storage.dataFile, Buffer.from("not-an-envelope"))

    const response = await harness.rpc<PutEnvelopeResponse>(
      ApiPaths.OPP.Methods.Envelope,
      routePutParams(storage.data, "batchop.rejected")
    )

    expect(response.status).toBe(200)
    expect(response.body.result).toBeUndefined()
    expect(response.body.error?.code).toBe(JsonRPC.ErrorCode.INTERNAL_ERROR)
    expect(Fs.existsSync(storage.metadataFile)).toBe(false)
    expect(Fs.readFileSync(storage.dataFile)).toEqual(
      Buffer.from("not-an-envelope")
    )
  })
})
