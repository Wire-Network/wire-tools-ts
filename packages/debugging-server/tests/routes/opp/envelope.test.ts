import * as OS from "node:os"
import * as Path from "node:path"
import * as Fs from "node:fs"

import { DebuggingServer } from "@wire-e2e-tests/debugging-server"
import { JsonRPCErrorCode } from "@wire-e2e-tests/debugging-server"
import {
  ApiPaths,
  DebugOutpostEndpointsType,
  DebugEnvelopeMetadataRecord,
  JsonRPCResult
} from "@wire-e2e-tests/debugging-shared"
import { Envelope } from "@wireio/opp-typescript-models"
import { Future } from "@3fv/prelude-ts"

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

// -----------------------------------------------------------------------
//  JSON-RPC 2.0 tests
// -----------------------------------------------------------------------
describe(`JSON-RPC 2.0 via POST ${ApiPaths.OPP.Endpoint}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `opp-jsonrpc-test-${Date.now()}`)
  let server: DebuggingServer
  let baseUrl: string
  let nextId = 1

  beforeAll(async () => {
    server = await DebuggingServer.create({ oppStoragePath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function rpcCall(method: string, params: any) {
    const id = nextId++
    return fetch(`${baseUrl}${ApiPaths.OPP.Endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id })
    }).then(async r => ({
      status: r.status,
      body: (await r.json()) as any,
      id
    }))
  }

  it("returns JSON-RPC 2.0 response with result for valid call", async () => {
    const { status, body, id } = await rpcCall(ApiPaths.OPP.Methods.Envelope, {
      batchOpName: "batchop.a",
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      envelopeData: makeEnvelopeBase64(100)
    })

    expect(status).toBe(200)
    expect(body.jsonrpc).toBe("2.0")
    expect(body.id).toBe(id)
    expect(body.result).toBeDefined()
    expect(body.result.key).toMatch(/^00000100-/)
    expect(body.result.dataExisted).toBe(false)
    expect(body.result.batchOpNames).toEqual(["batchop.a"])
    expect(body.error).toBeUndefined()
  })

  it("returns METHOD_NOT_FOUND for unknown method", async () => {
    const { body } = await rpcCall("/api/opp/nonexistent", {})

    expect(body.jsonrpc).toBe("2.0")
    expect(body.error).toBeDefined()
    expect(body.error.code).toBe(JsonRPCErrorCode.METHOD_NOT_FOUND)
    expect(body.result).toBeUndefined()
  })

  it("returns INVALID_REQUEST when jsonrpc field is missing", async () => {
    const resp = await fetch(`${baseUrl}${ApiPaths.OPP.Endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: ApiPaths.OPP.Methods.Envelope,
        params: {}
      })
    })

    expect(resp.status).toBe(400)
  })

  it("echoes the request id in the response", async () => {
    const { body, id } = await rpcCall(ApiPaths.OPP.Methods.Envelope, {
      batchOpName: "batchop.id-test",
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
      envelopeData: makeEnvelopeBase64(101)
    })

    expect(body.id).toBe(id)
  })

  it("deduplicates and appends batch_op_name via JSON-RPC", async () => {
    const b64 = makeEnvelopeBase64(102)
    const params = {
      endpointsType: DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
      envelopeData: b64
    }

    const r1 = await rpcCall(ApiPaths.OPP.Methods.Envelope, {
      ...params,
      batchOpName: "batchop.a"
    })
    const r2 = await rpcCall(ApiPaths.OPP.Methods.Envelope, {
      ...params,
      batchOpName: "batchop.b"
    })

    expect(r1.body.result.dataExisted).toBe(false)
    expect(r2.body.result.dataExisted).toBe(true)
    expect(r2.body.result.batchOpNames).toEqual(["batchop.a", "batchop.b"])
  })
})

// -----------------------------------------------------------------------
//  Plain JSON tests (unwrapped, direct POST to method path)
// -----------------------------------------------------------------------
describe(`Plain JSON via POST ${ApiPaths.OPP.Methods.Envelope}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `opp-plain-test-${Date.now()}`)
  let server: DebuggingServer
  let baseUrl: string

  beforeAll(async () => {
    server = await DebuggingServer.create({ oppStoragePath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("accepts plain JSON body and returns plain result", async () => {
    const resp = await fetch(`${baseUrl}${ApiPaths.OPP.Methods.Envelope}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchOpName: "batchop.plain",
        endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
        envelopeData: makeEnvelopeBase64(200)
      })
    })

    expect(resp.status).toBe(200)
    const result = (await resp.json()) as any
    // Plain JSON — no jsonrpc wrapper
    expect(result.key).toMatch(/^00000200-/)
    expect(result.batchOpNames).toEqual(["batchop.plain"])
    expect(result.jsonrpc).toBeUndefined()
  })

  it("auto-detects JSON-RPC when sent to individual method path", async () => {
    const resp = await fetch(`${baseUrl}${ApiPaths.OPP.Methods.Envelope}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: ApiPaths.OPP.Methods.Envelope,
        params: {
          batchOpName: "batchop.mixed",
          endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
          envelopeData: makeEnvelopeBase64(201)
        },
        id: 42
      })
    })

    expect(resp.status).toBe(200)
    const body = (await resp.json()) as any
    expect(body.jsonrpc).toBe("2.0")
    expect(body.id).toBe(42)
    expect(body.result.key).toMatch(/^00000201-/)
  })

  it("creates files on disk via plain JSON", async () => {
    const resp = await fetch(`${baseUrl}${ApiPaths.OPP.Methods.Envelope}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchOpName: "batchop.disk",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        envelopeData: makeEnvelopeBase64(202)
      })
    })

    const result = (await resp.json()) as any
    const dataFile = Path.join(tmpDir, `${result.key}.data`)
    const metadataFile = Path.join(tmpDir, `${result.key}.metadata`)
    expect(Fs.existsSync(dataFile)).toBe(true)
    expect(Fs.existsSync(metadataFile)).toBe(true)
  })
})

// -----------------------------------------------------------------------
//  Ping health check
// -----------------------------------------------------------------------
describe(`GET ${ApiPaths.Ping}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `opp-ping-test-${Date.now()}`)
  let server: DebuggingServer
  let baseUrl: string

  beforeAll(async () => {
    server = await DebuggingServer.create({ oppStoragePath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns 200 with status ok", async () => {
    const resp = await fetch(`${baseUrl}${ApiPaths.Ping}`)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as any
    expect(body.status).toBe("ok")
  })
})

// -----------------------------------------------------------------------
//  List envelopes
// -----------------------------------------------------------------------
describe(`JSON-RPC ${ApiPaths.OPP.Methods.EnvelopeList}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `opp-list-test-${Date.now()}`)
  let server: DebuggingServer
  let baseUrl: string
  let nextId = 1

  beforeAll(async () => {
    server = await DebuggingServer.create({ oppStoragePath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`

    // Seed with 3 envelopes across 2 epochs and 2 endpoints
    for (const [epoch, ep, name] of [
      [10, DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT, "batchop.a"],
      [10, DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM, "batchop.a"],
      [20, DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT, "batchop.b"]
    ] as const) {
      await rpcCall(ApiPaths.OPP.Methods.Envelope, {
        batchOpName: name,
        endpointsType: ep,
        envelopeData: makeEnvelopeBase64(epoch)
      })
    }
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function rpcCall(method: string, params: any): Promise<JsonRPCResult> {
    const id = nextId++
    const r = await fetch(`${baseUrl}${ApiPaths.OPP.Endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id })
    })
    return await Future.of(r.json())
      .map(body => ({
        status: r.status,
        body,
        id
      }))
      .toPromise()
  }

  it("returns all envelopes when no filters applied", async () => {
    const { body } = await rpcCall(ApiPaths.OPP.Methods.EnvelopeList, {})
    expect(body.result.total).toBe(3)
    expect(body.result.entries).toHaveLength(3)
  })

  it("filters by epoch range", async () => {
    const { body } = await rpcCall(ApiPaths.OPP.Methods.EnvelopeList, {
      epochStart: 10,
      epochEnd: 10
    })
    expect(body.result.total).toBe(2)
    body.result.entries.forEach((e: any) => {
      expect(e.epochIndex).toBe(10)
    })
  })

  it("filters by endpoints type", async () => {
    const { body } = await rpcCall(ApiPaths.OPP.Methods.EnvelopeList, {
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    })
    expect(body.result.total).toBe(1)
    expect(body.result.entries[0].endpointsType).toBe(
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    )
  })

  it("returns entries sorted lexicographically by key", async () => {
    const { body } = await rpcCall(ApiPaths.OPP.Methods.EnvelopeList, {})
    const keys = body.result.entries.map((e: any) => e.key)
    const sorted = [...keys].sort()
    expect(keys).toEqual(sorted)
  })

  it("each entry has all expected fields", async () => {
    const { body } = await rpcCall(ApiPaths.OPP.Methods.EnvelopeList, {})
    const entry = body.result.entries[0]
    expect(entry).toHaveProperty("key")
    expect(entry).toHaveProperty("epochIndex")
    expect(entry).toHaveProperty("endpointsType")
    expect(entry).toHaveProperty("checksum")
    expect(entry).toHaveProperty("batchOpNames")
    expect(entry).toHaveProperty("timestamp")
    expect(entry).toHaveProperty("dataSize")
    expect(entry.dataSize).toBeGreaterThan(0)
  })
})

// -----------------------------------------------------------------------
//  Get envelope
// -----------------------------------------------------------------------
describe(`JSON-RPC ${ApiPaths.OPP.Methods.EnvelopeGet}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `opp-get-test-${Date.now()}`)
  let server: DebuggingServer
  let baseUrl: string
  let nextId = 1
  let storedKey: string

  beforeAll(async () => {
    server = await DebuggingServer.create({ oppStoragePath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`

    // Seed one envelope
    const { body } = await rpcCall(ApiPaths.OPP.Methods.Envelope, {
      batchOpName: "batchop.a",
      endpointsType: DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
      envelopeData: makeEnvelopeBase64(50)
    })
    storedKey = body.result.key
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function rpcCall(method: string, params: any) {
    const id = nextId++
    return fetch(`${baseUrl}${ApiPaths.OPP.Endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id })
    }).then(async r => ({
      status: r.status,
      body: (await r.json()) as any,
      id
    }))
  }

  it("returns the full envelope for a valid key", async () => {
    const { body } = await rpcCall(ApiPaths.OPP.Methods.EnvelopeGet, {
      key: storedKey
    })
    const result = body.result

    expect(result.key).toBe(storedKey)
    expect(result.epochIndex).toBe(50)
    expect(result.batchOpNames).toEqual(["batchop.a"])
    expect(result.dataSize).toBeGreaterThan(0)
    // envelopeData is base64-encoded bytes
    expect(typeof result.envelopeData).toBe("string")
    expect(result.envelopeData.length).toBeGreaterThan(0)
  })

  it("returns an error for a nonexistent key", async () => {
    const { body } = await rpcCall(ApiPaths.OPP.Methods.EnvelopeGet, {
      key: "00000000-FAKE-0000"
    })
    expect(body.error).toBeDefined()
    expect(body.error.message).toContain("not found")
  })

  it("envelope data can be decoded back to a valid Envelope", async () => {
    const { body } = await rpcCall(ApiPaths.OPP.Methods.EnvelopeGet, {
      key: storedKey
    })
    const envelopeBytes = Buffer.from(body.result.envelopeData, "base64")
    const envelope = Envelope.fromBinary(envelopeBytes)
    expect(envelope.epochIndex).toBe(50)
  })
})
