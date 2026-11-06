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
  /**
   * The engine's INVALID_PARAMS message for a params object it cannot read as
   * a named `query` (the engine's `invalid_params_message`). An engine that
   * predates schema 1.1 sends it for ANY member beyond `query`; a paging
   * engine sends it only for a missing or empty `query`.
   */
  export const InvalidParamsMessage = "Expected named query parameter"
  /**
   * A JSON-RPC method the engine does not serve, sent by the engine probe
   * (`QueryEngineClient.ping`). The engine answers it with METHOD_NOT_FOUND
   * from the request envelope alone, before reading any chain state, so that
   * answer proves `query_engine_plugin` is serving {@link ExecutePath}.
   */
  export const ProbeMethod = "query.probe"
}

/** JSON-RPC method names (identity enum; quoted member because of the dot). */
export enum QueryEngineMethod {
  "query.execute" = "query.execute"
}
