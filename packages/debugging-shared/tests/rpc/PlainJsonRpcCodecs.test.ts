import {
  ApiPaths,
  GetClusterConfigRequestSchemaCodec,
  GetClusterStateResponseSchemaCodec,
  GetProcessLivenessRequestSchemaCodec,
  GetProcessLivenessResponseSchemaCodec,
  ListProcessesResponseSchemaCodec,
  LogReadRequestSchemaCodec,
  LogReadResponseSchemaCodec,
  LogStatResponseSchemaCodec,
  PidSourceKind,
  PlainJsonRpcResponseCodecs,
  type GetProcessLivenessRequest,
  type LogReadRequest,
  type LogReadResponse,
  type LogStatResponse
} from "@wireio/debugging-shared"

describe("plain-JSON RPC per-shape codecs", () => {
  it("round-trips a Processes.GetLiveness request + response (nullable fields)", () => {
    const request: GetProcessLivenessRequest = {
      labels: ["bios", "producer_00"]
    }
    expect(
      GetProcessLivenessRequestSchemaCodec.deserialize(
        GetProcessLivenessRequestSchemaCodec.serialize(request)
      )
    ).toEqual(request)

    const response = {
      snapshots: [
        { label: "bios", pid: 42, alive: true, lastCheckedAt: 1, exitedAt: null }
      ]
    }
    expect(
      GetProcessLivenessResponseSchemaCodec.deserialize(
        GetProcessLivenessResponseSchemaCodec.serialize(response)
      )
    ).toEqual(response)
  })

  it("rejects a malformed liveness response (wrong `alive` type)", () => {
    expect(
      GetProcessLivenessResponseSchemaCodec.check({
        snapshots: [
          {
            label: "x",
            pid: 1,
            alive: "yes",
            lastCheckedAt: 1,
            exitedAt: null
          }
        ]
      })
    ).toBe(false)
  })

  it("round-trips a Processes.List response carrying a PidSource", () => {
    const response = {
      sources: [
        {
          label: "bios",
          pidPath: "/x/bios.pid",
          directory: "/x",
          kind: PidSourceKind.Bios
        }
      ]
    }
    expect(
      ListProcessesResponseSchemaCodec.deserialize(
        ListProcessesResponseSchemaCodec.serialize(response)
      )
    ).toEqual(response)
  })

  it("round-trips + validates the Logs codecs", () => {
    const stat: LogStatResponse = {
      path: "/x.log",
      ino: 1,
      totalBytes: 10,
      totalLines: 2
    }
    expect(
      LogStatResponseSchemaCodec.deserialize(
        LogStatResponseSchemaCodec.serialize(stat)
      )
    ).toEqual(stat)

    const readRequest: LogReadRequest = { path: "/x.log", fromLine: 0, count: 5 }
    expect(
      LogReadRequestSchemaCodec.deserialize(
        LogReadRequestSchemaCodec.serialize(readRequest)
      )
    ).toEqual(readRequest)

    const readResponse: LogReadResponse = { lines: ["a", "b"] }
    expect(
      LogReadResponseSchemaCodec.deserialize(
        LogReadResponseSchemaCodec.serialize(readResponse)
      )
    ).toEqual(readResponse)

    // Missing totalBytes / totalLines.
    expect(LogStatResponseSchemaCodec.check({ path: "/x", ino: 1 })).toBe(false)
  })

  it("validates the Cluster request/state codecs", () => {
    expect(GetClusterConfigRequestSchemaCodec.check({})).toBe(true)
    expect(GetClusterStateResponseSchemaCodec.check({ state: null })).toBe(true)
    // A non-null but structurally-invalid state is rejected.
    expect(
      GetClusterStateResponseSchemaCodec.check({ state: { bogus: 1 } })
    ).toBe(false)
  })

  it("registry maps plain-JSON methods and omits proto methods", () => {
    expect(
      PlainJsonRpcResponseCodecs[ApiPaths.Cluster.Methods.GetConfig]
    ).toBeDefined()
    expect(
      PlainJsonRpcResponseCodecs[ApiPaths.Processes.Methods.List]
    ).toBeDefined()
    expect(
      PlainJsonRpcResponseCodecs[ApiPaths.Logs.Methods.GetStat]
    ).toBeDefined()
    // Proto (and proto-embedding) methods are absent — validated by protobuf-ts.
    expect(
      PlainJsonRpcResponseCodecs[ApiPaths.OPP.Methods.Envelope]
    ).toBeUndefined()
    expect(
      PlainJsonRpcResponseCodecs[ApiPaths.OPP.Methods.LoadRecords]
    ).toBeUndefined()
  })
})
