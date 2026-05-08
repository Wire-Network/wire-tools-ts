import {
  ApiPaths,
  type GetClusterConfigResponse,
  type GetProcessLivenessRequest,
  type InferredRequestType,
  type InferredResponseType,
  type LogReadResponse,
  type LogStat
} from "@wireio/debugging-shared"

describe("ApiPaths feature endpoints", () => {
  it("Cluster.Endpoint is /api/cluster", () => {
    expect(ApiPaths.Cluster.Endpoint).toBe("/api/cluster")
  })

  it("Processes.Endpoint is /api/processes", () => {
    expect(ApiPaths.Processes.Endpoint).toBe("/api/processes")
  })

  it("Logs.Endpoint is /api/logs", () => {
    expect(ApiPaths.Logs.Endpoint).toBe("/api/logs")
  })

  it("Stream.Path is /api/stream", () => {
    expect(ApiPaths.Stream.Path).toBe("/api/stream")
  })
})

describe("ApiPaths.*.Methods", () => {
  it("Cluster methods are namespaced", () => {
    expect(ApiPaths.Cluster.Methods.GetConfig).toBe("Cluster.GetConfig")
    expect(ApiPaths.Cluster.Methods.GetState).toBe("Cluster.GetState")
  })

  it("Processes methods are namespaced", () => {
    expect(ApiPaths.Processes.Methods.List).toBe("Processes.List")
    expect(ApiPaths.Processes.Methods.GetLiveness).toBe("Processes.GetLiveness")
  })

  it("Logs methods are namespaced", () => {
    expect(ApiPaths.Logs.Methods.GetStat).toBe("Logs.GetStat")
    expect(ApiPaths.Logs.Methods.Read).toBe("Logs.Read")
  })
})

describe("InferredRequestType / InferredResponseType", () => {
  it("infers the cluster config response from the method enum", () => {
    const sample: InferredResponseType<
      typeof ApiPaths.Cluster.Methods.GetConfig
    > = {} as GetClusterConfigResponse
    expect(typeof sample).toBe("object")
  })

  it("infers process-liveness request shape", () => {
    const sample: InferredRequestType<
      typeof ApiPaths.Processes.Methods.GetLiveness
    > = { labels: ["nodeop"] } satisfies GetProcessLivenessRequest
    expect(sample.labels).toEqual(["nodeop"])
  })

  it("infers log read/stat shapes", () => {
    const stat: InferredResponseType<
      typeof ApiPaths.Logs.Methods.GetStat
    > = {
      path: "/x.log",
      ino: 1,
      totalBytes: 0,
      totalLines: 0
    } satisfies LogStat
    expect(stat.path).toBe("/x.log")

    const read: InferredResponseType<typeof ApiPaths.Logs.Methods.Read> = {
      lines: ["alpha"]
    } satisfies LogReadResponse
    expect(read.lines.length).toBe(1)
  })
})
