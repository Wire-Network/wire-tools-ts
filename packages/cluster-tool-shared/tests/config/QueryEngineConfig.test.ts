import {
  NodeopReadMode,
  QueryEngineConfigSchema,
  QueryEngineLimitSchema,
  QueryEngineReadModeSchema,
  SchemaCodec,
  createUnsetQueryEngineConfig,
  type QueryEngineConfig
} from "@wireio/cluster-tool-shared"

/** The persisted query-engine config's codec (it rides `ClusterConfig.queryEngine`). */
const QueryEngineConfigCodec = SchemaCodec.create<QueryEngineConfig>(
  QueryEngineConfigSchema
)

/** Every member set (limit values are plain counts, not ports). */
const SetQueryEngine: QueryEngineConfig = {
  readMode: NodeopReadMode.irreversible,
  workerThreads: 4,
  maxInFlight: 8,
  maxQueryBytes: 65_536,
  timeoutMs: 5_000,
  maxCaptureMs: 2_000,
  maxAbiBytes: 1_048_576,
  maxScanRows: 100_000,
  maxRawBytes: 1_048_576,
  maxMemoryBytes: 67_108_864,
  maxGroups: 1_000,
  maxResultRows: 500,
  maxResponseBytes: 4_194_304
}

describe("QueryEngineReadModeSchema", () => {
  it("offers exactly the two read modes the plugin serves in", () => {
    expect(QueryEngineReadModeSchema.options).toEqual([
      NodeopReadMode.head,
      NodeopReadMode.irreversible
    ])
  })

  it("accepts head and irreversible and rejects speculative", () => {
    expect(
      QueryEngineReadModeSchema.safeParse(NodeopReadMode.head).success
    ).toBe(true)
    expect(
      QueryEngineReadModeSchema.safeParse(NodeopReadMode.irreversible).success
    ).toBe(true)
    expect(
      QueryEngineReadModeSchema.safeParse(NodeopReadMode.speculative).success
    ).toBe(false)
  })
})

describe("QueryEngineLimitSchema", () => {
  it.each([null, 1])("accepts %s", value => {
    expect(QueryEngineLimitSchema.safeParse(value).success).toBe(true)
  })

  it.each([0, -1, 1.5, 2 ** 53, "100"])("rejects %s", value => {
    expect(QueryEngineLimitSchema.safeParse(value).success).toBe(false)
  })
})

describe("QueryEngineConfigSchema", () => {
  it("round-trips an all-unset config with every member surviving as null", () => {
    const serialized = QueryEngineConfigCodec.serialize(
      createUnsetQueryEngineConfig()
    )
    expect(JSON.parse(serialized)).toEqual(createUnsetQueryEngineConfig())
    expect(QueryEngineConfigCodec.deserialize(serialized)).toEqual(
      createUnsetQueryEngineConfig()
    )
  })

  it("round-trips a config with every member set", () => {
    expect(
      QueryEngineConfigCodec.deserialize(
        QueryEngineConfigCodec.serialize(SetQueryEngine)
      )
    ).toEqual(SetQueryEngine)
  })

  it("rejects a document missing a member (every member is required, nullable)", () => {
    const parsed = JSON.parse(QueryEngineConfigCodec.serialize(SetQueryEngine))
    delete parsed.maxGroups
    expect(() =>
      QueryEngineConfigCodec.deserialize(JSON.stringify(parsed))
    ).toThrow(/maxGroups/)
  })

  it("rejects a speculative readMode", () => {
    const parsed = JSON.parse(QueryEngineConfigCodec.serialize(SetQueryEngine))
    parsed.readMode = NodeopReadMode.speculative
    expect(() =>
      QueryEngineConfigCodec.deserialize(JSON.stringify(parsed))
    ).toThrow(/readMode/)
  })
})

describe("createUnsetQueryEngineConfig", () => {
  it("carries exactly the schema's members, every one null", () => {
    const unset = createUnsetQueryEngineConfig()
    expect(Object.keys(unset).sort()).toEqual(
      Object.keys(QueryEngineConfigSchema.shape).sort()
    )
    Object.values(unset).forEach(value => expect(value).toBeNull())
  })
})
