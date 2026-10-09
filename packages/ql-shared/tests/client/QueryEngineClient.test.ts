import { identity } from "lodash"

import { Level } from "@wireio/shared"

import {
  JsonRPCTransportError,
  JsonRPCTransportStage
} from "@wireio/cluster-tool-shared"

import {
  createQueryEngineClientDefaultOptions,
  QueryEngineClient,
  QueryEngineRPC,
  QueryErrorCode,
  QueryErrorKind,
  QueryExecutionStatus,
  QueryFailure,
  QueryFailureError,
  QueryFailureKind,
  QueryTransportError,
  type QueryExecution,
  type QueryExecutionFailure,
  type QueryExecutionSuccess
} from "@wireio/ql-shared"

import { LogCapture } from "../common/logCapture.js"
import { createProfile, FixtureEndpoint } from "../common/profileFixtures.js"
import { readEngineExample } from "../common/resultFixtures.js"

const RequestId = "req-1",
  profile = createProfile({ name: "local", retries: 2 }),
  successBody = () => ({ ...JSON.parse(readEngineExample("response.json")), id: RequestId }),
  errorBody = (kind: QueryErrorKind, retryable: boolean) => ({
    jsonrpc: "2.0",
    id: RequestId,
    error: {
      code: QueryErrorCode[kind],
      message: `${kind} happened`,
      data: { kind, retryable, line: kind === QueryErrorKind.QUERY_SYNTAX ? 1 : null, column: kind === QueryErrorKind.QUERY_SYNTAX ? 32 : null, limit: null }
    }
  })

/** One scripted response: a JSON body, raw text, a status, or a thrown error. */
interface ScriptedResponse {
  body?: object
  text?: string
  status?: number
  reject?: Error
}

/** A recorded request. */
interface RecordedRequest {
  url: string
  init: RequestInit
}

/** A fetch stub that answers from a script and records the requests. */
function scriptedFetch(script: ScriptedResponse[]) {
  const requests: RecordedRequest[] = []
  const fetchProvider = (async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    const next = script[Math.min(requests.length - 1, script.length - 1)]
    if (next.reject) throw next.reject
    const { status = 200 } = next
    return new Response(status === 204 ? null : (next.text ?? JSON.stringify(next.body)), { status })
  }) as unknown as typeof fetch
  return { fetchProvider, requests }
}

const createClient = (script: ScriptedResponse[], clientProfile = profile) => {
  const stub = scriptedFetch(script)
  return { client: new QueryEngineClient(clientProfile, { fetchProvider: stub.fetchProvider, createRequestId: () => RequestId }), requests: stub.requests }
}

const sentParams = (request: RecordedRequest) => JSON.parse(request.init.body as string).params
const asFailure = (execution: QueryExecution) => execution as QueryExecutionFailure

describe("QueryEngineClient", () => {
  let logs: LogCapture
  beforeEach(() => {
    logs = new LogCapture().install()
    jest.useRealTimers()
  })
  afterEach(() => logs.uninstall())

  it("derives the execute URL from the profile endpoint", () => {
    expect(createClient([]).client.executeURL).toBe(`${FixtureEndpoint}${QueryEngineRPC.ExecutePath}`)
  })

  it("executes a plain query sending exactly {query} and logs the outcome", async () => {
    const { client, requests } = createClient([{ body: successBody() }]),
      execution = await client.execute("SELECT 1")
    expect(execution.status).toBe(QueryExecutionStatus.success)
    expect((execution as QueryExecutionSuccess).result.page.limit).toBe("20")
    expect(execution).toMatchObject({ requestId: RequestId, query: "SELECT 1", attempts: 1 })
    expect(sentParams(requests[0])).toEqual({ query: "SELECT 1" })
    expect(requests[0].init.method).toBe("POST")
    expect(JSON.parse(requests[0].init.body as string)).toMatchObject({ jsonrpc: "2.0", id: RequestId, method: "query.execute" })
    expect(logs.messages(Level.info).some(message => message.includes("outcome=success"))).toBe(true)
    expect(logs.records.find(record => record.message.includes("outcome=success")).category).toBe("client:QueryEngineClient")
    expect(logs.messages(Level.debug).some(message => message.includes("SELECT 1"))).toBe(true)
  })

  it("sends limit / offset / timeoutMs as limit / offset / timeout_ms, omitting unset members", async () => {
    const { client, requests } = createClient([{ body: successBody() }])
    await client.execute("q", { limit: 5, offset: 10, timeoutMs: 400 })
    expect(sentParams(requests[0])).toEqual({ query: "q", limit: 5, offset: 10, timeout_ms: 400 })
    await client.execute("q", { limit: null, offset: undefined })
    expect(sentParams(requests[1])).toEqual({ query: "q" })
  })

  it("falls back to the profile's queryTimeoutMs", () => {
    expect(
      QueryEngineClient.createRequestParams("q", {}, createProfile({ queryTimeoutMs: 700 }))
    ).toEqual({ query: "q", timeout_ms: 700 })
  })

  it("raises the transport ceiling above an explicit server deadline", () => {
    expect(QueryEngineClient.transportCeilingMs(profile, undefined)).toBe(profile.transportTimeoutMs)
    expect(QueryEngineClient.transportCeilingMs(profile, 1_000)).toBe(profile.transportTimeoutMs)
    expect(QueryEngineClient.transportCeilingMs(profile, 9_000)).toBe(9_000 + QueryEngineClient.TransportAllowanceMs)
  })

  it("describe sends limit 0 and returns the columns", async () => {
    const { client, requests } = createClient([{ body: successBody() }]),
      columns = await client.describe("sysio.opreg", "operators")
    expect(columns.map(column => column.name)).toEqual(["beneficiary", "records", "total"])
    expect(sentParams(requests[0])).toEqual({ query: "SELECT * FROM \"sysio.opreg\".operators", limit: 0 })
  })

  it("describe throws a QueryFailureError carrying the engine failure unchanged", async () => {
    const { client } = createClient([{ body: errorBody(QueryErrorKind.QUERY_SEMANTICS, false) }]),
      error = await client.describe("sample", "nope").then(() => null, identity<QueryFailureError>)
    expect(error).toBeInstanceOf(QueryFailureError)
    expect(error.message).toContain("describe sample.nope failed")
    expect(error.failure).toMatchObject({ kind: QueryFailureKind.engine, data: { kind: QueryErrorKind.QUERY_SEMANTICS, retryable: false } })
    expect(QueryFailure.of(error)).toBe(error.failure)
  })

  it.each(Object.values(QueryErrorKind))("maps engine kind %s to an engine failure", async kind => {
    const retryable = kind === QueryErrorKind.QUERY_TIMEOUT,
      { client } = createClient([{ body: errorBody(kind, retryable) }]),
      execution = asFailure(await client.execute("q"))
    expect(execution.failure).toMatchObject({ kind: QueryFailureKind.engine, code: QueryErrorCode[kind], data: { kind, retryable } })
    expect(execution.attempts).toBe(1)
  })

  it("keeps the engine position on syntax errors", async () => {
    const { client } = createClient([{ body: errorBody(QueryErrorKind.QUERY_SYNTAX, false) }])
    expect(asFailure(await client.execute("q")).failure.data).toMatchObject({ line: 1, column: 32 })
  })

  it("auto-retries a retryable BUSY and then succeeds, logging each retry", async () => {
    const { client, requests } = createClient([{ body: errorBody(QueryErrorKind.QUERY_BUSY, true) }, { body: successBody() }]),
      execution = await client.execute("q")
    expect(execution.status).toBe(QueryExecutionStatus.success)
    expect(execution.attempts).toBe(2)
    expect(requests).toHaveLength(2)
    expect(logs.messages(Level.warn).some(message => message.includes("QUERY_BUSY"))).toBe(true)
  })

  it("stops after the profile's retries are exhausted", async () => {
    const { client, requests } = createClient([{ body: errorBody(QueryErrorKind.STATE_UNAVAILABLE, true) }]),
      execution = asFailure(await client.execute("q"))
    expect(execution.attempts).toBe(profile.retries + 1)
    expect(requests).toHaveLength(profile.retries + 1)
    expect(execution.failure.data.kind).toBe(QueryErrorKind.STATE_UNAVAILABLE)
  })

  it("adds the upgrade hint to INVALID_PARAMS only when paging params were sent", async () => {
    const paged = createClient([{ body: errorBody(QueryErrorKind.INVALID_PARAMS, false) }]),
      plain = createClient([{ body: errorBody(QueryErrorKind.INVALID_PARAMS, false) }])
    expect(asFailure(await paged.client.execute("q", { limit: 1 })).failure.message).toContain(QueryEngineClient.UpgradeHint)
    expect(asFailure(await plain.client.execute("q")).failure.message).not.toContain(QueryEngineClient.UpgradeHint)
  })

  it("rejects a schema_version other than 1.1 naming both versions", async () => {
    const body = successBody()
    body.result.schema_version = "1.0"
    const { client } = createClient([{ body }]),
      failure = asFailure(await client.execute("q")).failure
    expect(failure.kind).toBe(QueryFailureKind.transport)
    expect(failure.message).toContain("1.0")
    expect(failure.message).toContain("1.1")
  })

  it.each([
    ["HTTP 500", { status: 500, text: "boom" }, "HTTP 500"],
    ["HTTP 204", { status: 204 }, "HTTP 204"],
    ["malformed JSON", { text: "{nope" }, "invalid query.execute envelope"],
    ["id mismatch", { body: { ...successBody(), id: "other" } }, "id mismatch"],
    ["fetch rejection", { reject: new TypeError("fetch failed") }, "failed"]
  ] as const)("maps %s to a transport failure (logged)", async (_name, response, message) => {
    const { client } = createClient([response as ScriptedResponse]),
      failure = asFailure(await client.execute("q")).failure
    expect(failure).toEqual({ kind: QueryFailureKind.transport, message: expect.stringContaining(message), code: null, data: null })
    expect(failure.message).toContain(message)
    expect(logs.messages(Level.warn).some(text => text.includes("transport failure"))).toBe(true)
  })

  it("maps a caller abort to a cancelled failure", async () => {
    const controller = new AbortController(),
      fetchProvider = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason))
          controller.abort()
        })) as unknown as typeof fetch,
      client = new QueryEngineClient(profile, { fetchProvider, createRequestId: () => RequestId }),
      execution = asFailure(await client.execute("q", { signal: controller.signal }))
    expect(execution.failure.kind).toBe(QueryFailureKind.cancelled)
  })

  it("cancels during backoff", async () => {
    const controller = new AbortController(),
      { client } = createClient([{ body: errorBody(QueryErrorKind.QUERY_BUSY, true) }]),
      pending = client.execute("q", { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    expect(asFailure(await pending).failure.kind).toBe(QueryFailureKind.cancelled)
  })

  it("reports a transport timeout when the ceiling elapses", async () => {
    const fetchProvider = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))) as unknown as typeof fetch,
      quick = createProfile({ name: "quick", transportTimeoutMs: 20 }),
      client = new QueryEngineClient(quick, { fetchProvider, createRequestId: () => RequestId }),
      failure = asFailure(await client.execute("q")).failure
    expect(failure.kind).toBe(QueryFailureKind.transport)
    expect(failure.message).toContain("transport timeout after 20ms")
  })

  it("rejects an invalid request (a caller bug, not an outcome)", async () => {
    const { client } = createClient([{ body: successBody() }])
    await expect(client.execute("q", { limit: -1 })).rejects.toThrow()
  })

  it("maps a failure while reading the body to a transport failure", async () => {
    const fetchProvider = (async () => ({ ok: true, status: 200, statusText: "", text: () => { throw "not an error" } })) as unknown as typeof fetch,
      client = new QueryEngineClient(profile, { fetchProvider, createRequestId: () => RequestId })
    expect(asFailure(await client.execute("q")).failure.kind).toBe(QueryFailureKind.transport)
  })

  it("default options bind fetch and generate UUID request ids", () => {
    const defaults = createQueryEngineClientDefaultOptions(),
      detached = defaults.fetchProvider
    expect(typeof detached).toBe("function")
    expect(detached.name).toContain("bound")
    expect(defaults.createRequestId()).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("backoff resolves after the delay and rejects when already aborted", async () => {
    await expect(QueryEngineClient.backoff(1)).resolves.toBeUndefined()
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    await expect(QueryEngineClient.backoff(1_000, controller.signal)).rejects.toThrow("stop")
  })

  it("transportError maps each transport stage and passes other errors through", () => {
    const attempt = { ceilingMs: 30, timedOut: false },
      failed = (stage: JsonRPCTransportStage, body: unknown = null) =>
        new JsonRPCTransportError(`${stage} failed`, { stage, url: "http://x", status: 500, requestId: RequestId, body }),
      messageOf = (error: unknown) => (error as QueryTransportError).detail
    expect(messageOf(QueryEngineClient.transportError(failed(JsonRPCTransportStage.status), attempt))).toBe("status failed")
    expect(messageOf(QueryEngineClient.transportError(failed(JsonRPCTransportStage.request), { ...attempt, timedOut: true }))).toBe(
      "transport timeout after 30ms"
    )
    expect(messageOf(QueryEngineClient.transportError(failed(JsonRPCTransportStage.read), { ...attempt, timedOut: true }))).toBe(
      "transport timeout after 30ms reading the response"
    )
    expect(messageOf(QueryEngineClient.transportError(failed(JsonRPCTransportStage.decode, { result: {} }), attempt))).toBe(
      QueryEngineClient.InvalidEnvelopeMessage
    )
    expect(
      messageOf(QueryEngineClient.transportError(failed(JsonRPCTransportStage.decode, { result: { schema_version: "2.0" } }), attempt))
    ).toContain("schema_version 2.0")
    const mapped = QueryEngineClient.transportError(failed(JsonRPCTransportStage.id), attempt) as QueryTransportError
    expect(mapped).toBeInstanceOf(QueryTransportError)
    expect(mapped).toMatchObject({ status: 500, requestId: RequestId, url: "http://x" })
    const unrelated = new RangeError("caller bug")
    expect(QueryEngineClient.transportError(unrelated, attempt)).toBe(unrelated)
  })

  it("describeOutcome names the result or the failure", () => {
    expect(
      QueryEngineClient.describeOutcome({ status: QueryExecutionStatus.failure, requestId: "r", query: "q", wallTimeMs: 0, attempts: 1, failure: QueryEngineClient.cancelledFailure() })
    ).toBe(QueryFailureKind.cancelled)
  })
})
