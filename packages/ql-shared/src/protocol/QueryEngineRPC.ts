/** The query-engine plugin's JSON-RPC surface — the ONE spelling of path + schema version. */
export namespace QueryEngineRPC {
  /** HTTP path served by `sysio::query_engine_plugin` on the node's http-server-address. */
  export const ExecutePath = "/v1/query/execute"
  /** Response `schema_version` this client understands (1.1 = HTTP paging); any other version is rejected. */
  export const SchemaVersion = "1.1"
  /** Longest string `id` the engine accepts. */
  export const MaxStringIdLength = 128
  /** Largest integer `id` magnitude the engine accepts. */
  export const MaxIntegerId = 4_294_967_295
  /** Largest `limit` / `offset` / `timeout_ms` the engine accepts (2^53-1, the engine's `max_request_integer`). */
  export const MaxRequestInteger = Number.MAX_SAFE_INTEGER
  /** Smallest `timeout_ms` the engine accepts. */
  export const MinRequestTimeoutMs = 1
}

/** JSON-RPC method names (identity enum; quoted member because of the dot). */
export enum QueryEngineMethod {
  "query.execute" = "query.execute"
}
