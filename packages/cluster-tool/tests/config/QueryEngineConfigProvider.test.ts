import {
  NodeopReadMode,
  QueryEngineLimitsSchema,
  type QueryEngineOptions
} from "@wireio/cluster-tool-shared"

import { Constants } from "@wireio/cluster-tool/Constants"
import { QueryEngineConfigProvider } from "@wireio/cluster-tool/config"

describe("QueryEngineConfigProvider", () => {
  describe("resolve", () => {
    it("leaves every member unset by default (nodeop's read mode, the plugin's limits)", () => {
      const config = QueryEngineConfigProvider.resolve()
      expect(config.readMode).toBeNull()
      Constants.QUERY_ENGINE_LIMIT_OPTIONS.forEach(({ member }) =>
        expect(config[member]).toBeNull()
      )
      expect(config).toEqual(QueryEngineConfigProvider.createDefaultOptions())
    })

    it("keeps caller values and fills the rest with null", () => {
      const config = QueryEngineConfigProvider.resolve({
        readMode: NodeopReadMode.irreversible,
        maxInFlight: 8
      })
      expect(config.readMode).toBe(NodeopReadMode.irreversible)
      expect(config.maxInFlight).toBe(8)
      expect(config.workerThreads).toBeNull()
    })

    it.each([
      ["zero", { timeoutMs: 0 }, /query-timeout-ms must be a positive integer/],
      ["a fraction", { maxScanRows: 1.5 }, /query-max-scan-rows/],
      [
        "an unsafe integer",
        { maxGroups: Number.MAX_SAFE_INTEGER + 2 },
        /query-max-groups/
      ]
    ])("rejects %s, naming the nodeop option", (_, options, message) => {
      expect(() => QueryEngineConfigProvider.resolve(options)).toThrow(message)
    })

    it("rejects a read mode the plugin refuses", () => {
      // A JSON round-trip models untyped document data bypassing the subset
      // type (which excludes `speculative`).
      const options: QueryEngineOptions = JSON.parse(
        JSON.stringify({ readMode: NodeopReadMode.speculative })
      )
      expect(() => QueryEngineConfigProvider.resolve(options)).toThrow(
        /read-mode must be one of head \| irreversible/
      )
    })

    it("enforces the plugin's pairwise rules only when BOTH halves are set", () => {
      expect(() =>
        QueryEngineConfigProvider.resolve({ maxCaptureMs: 60, timeoutMs: 50 })
      ).toThrow(
        /query-max-capture-ms \(60\) must not exceed query-timeout-ms \(50\)/
      )
      expect(() =>
        QueryEngineConfigProvider.resolve({ maxRawBytes: 2, maxMemoryBytes: 1 })
      ).toThrow(/query-max-raw-bytes/)
      expect(
        QueryEngineConfigProvider.resolve({ maxCaptureMs: 60, timeoutMs: 60 })
          .maxCaptureMs
      ).toBe(60)
      expect(
        QueryEngineConfigProvider.resolve({ maxCaptureMs: 60 }).timeoutMs
      ).toBeNull()
      expect(
        QueryEngineConfigProvider.resolve({ maxRawBytes: 2 }).maxMemoryBytes
      ).toBeNull()
    })

    it("covers every limit the shared schema declares", () => {
      expect(
        Constants.QUERY_ENGINE_LIMIT_OPTIONS.map(({ member }) => member).sort()
      ).toEqual(Object.keys(QueryEngineLimitsSchema.shape).sort())
    })
  })

  describe("toIniLines", () => {
    it("renders nothing when nothing is set", () => {
      expect(
        QueryEngineConfigProvider.toIniLines(
          QueryEngineConfigProvider.createDefaultOptions()
        )
      ).toEqual([])
    })

    it("renders read-mode first, then one query-* line per SET limit in the plugin's order", () => {
      expect(
        QueryEngineConfigProvider.toIniLines(
          QueryEngineConfigProvider.resolve({
            readMode: NodeopReadMode.irreversible,
            maxResponseBytes: 1_048_576,
            maxInFlight: 8
          })
        )
      ).toEqual([
        "read-mode = irreversible",
        "query-max-in-flight = 8",
        "query-max-response-bytes = 1048576"
      ])
    })

    it("renders a set limit without a read-mode line", () => {
      expect(
        QueryEngineConfigProvider.toIniLines(
          QueryEngineConfigProvider.resolve({ maxGroups: 50 })
        )
      ).toEqual(["query-max-groups = 50"])
    })

    it("renders every member under its own nodeop option, in the plugin's order", () => {
      expect(
        QueryEngineConfigProvider.toIniLines(
          QueryEngineConfigProvider.resolve({
            readMode: NodeopReadMode.irreversible,
            workerThreads: 1,
            maxInFlight: 2,
            maxQueryBytes: 3,
            timeoutMs: 40,
            maxCaptureMs: 5,
            maxAbiBytes: 6,
            maxScanRows: 7,
            maxRawBytes: 8,
            maxMemoryBytes: 90,
            maxGroups: 10,
            maxResultRows: 11,
            maxResponseBytes: 12
          })
        )
      ).toEqual([
        "read-mode = irreversible",
        "query-worker-threads = 1",
        "query-max-in-flight = 2",
        "query-max-query-bytes = 3",
        "query-timeout-ms = 40",
        "query-max-capture-ms = 5",
        "query-max-abi-bytes = 6",
        "query-max-scan-rows = 7",
        "query-max-raw-bytes = 8",
        "query-max-memory-bytes = 90",
        "query-max-groups = 10",
        "query-max-result-rows = 11",
        "query-max-response-bytes = 12"
      ])
    })
  })
})
