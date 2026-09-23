import { z } from "zod"

import { NodeopReadMode } from "./NodeopReadMode.js"

/**
 * The read modes `sysio::query_engine_plugin` serves in — it rejects
 * `speculative`. Its `.options` is the CLI choice list of both API-node commands.
 */
export const QueryEngineReadModeSchema = z.enum([
  NodeopReadMode.head,
  NodeopReadMode.irreversible
])
/** A read mode the query engine accepts (the enum-member subset, not widened strings). */
export type QueryEngineReadMode = z.infer<typeof QueryEngineReadModeSchema>

/**
 * One `query-*` limit: a positive safe integer, or `null` for "not set":
 * nothing is rendered and the plugin's own built-in default stays in force.
 * zod 4's `.int()` is the safe-integer format, so no value above
 * `Number.MAX_SAFE_INTEGER` reaches an ini — `toIniLine` would render it with
 * silently altered digits (`2 ** 60` → `1152921504606847000`), or from `1e21`
 * up in exponent form, which the plugin's parser rejects. The plugin is the
 * single author of every default, so none is re-spelled here.
 */
export const QueryEngineLimitSchema = z.number().int().positive().nullable()

/** The plugin's twelve `query-*` limits, keyed by camelCase member. */
export const QueryEngineLimitsSchema = z.object({
  /** `query-worker-threads`. */
  workerThreads: QueryEngineLimitSchema,
  /** `query-max-in-flight`. */
  maxInFlight: QueryEngineLimitSchema,
  /** `query-max-query-bytes`. */
  maxQueryBytes: QueryEngineLimitSchema,
  /** `query-timeout-ms`. */
  timeoutMs: QueryEngineLimitSchema,
  /** `query-max-capture-ms`. */
  maxCaptureMs: QueryEngineLimitSchema,
  /** `query-max-abi-bytes`. */
  maxAbiBytes: QueryEngineLimitSchema,
  /** `query-max-scan-rows`. */
  maxScanRows: QueryEngineLimitSchema,
  /** `query-max-raw-bytes`. */
  maxRawBytes: QueryEngineLimitSchema,
  /** `query-max-memory-bytes`. */
  maxMemoryBytes: QueryEngineLimitSchema,
  /** `query-max-groups`. */
  maxGroups: QueryEngineLimitSchema,
  /** `query-max-result-rows`. */
  maxResultRows: QueryEngineLimitSchema,
  /** `query-max-response-bytes`. */
  maxResponseBytes: QueryEngineLimitSchema
})
/** The plugin's limits — the shape of {@link QueryEngineLimitsSchema}. */
export type QueryEngineLimits = z.infer<typeof QueryEngineLimitsSchema>
/** A limit's member name. */
export type QueryEngineLimitKey = keyof QueryEngineLimits

/**
 * The query-engine config of a cluster's API nodes (persisted as
 * `ClusterConfig.queryEngine`) and of a standalone `create-api-node` artifact:
 * the node's read mode plus the limits. Every member is nullable — `null` is
 * "not set, nodeop's / the plugin's default governs" — and every set member
 * renders as one ini line.
 */
export const QueryEngineConfigSchema = QueryEngineLimitsSchema.extend({
  /** The node's `read-mode`; `null` leaves nodeop's own default (`head`) in force. */
  readMode: QueryEngineReadModeSchema.nullable()
})
/** The resolved query-engine config — the shape of {@link QueryEngineConfigSchema}. */
export type QueryEngineConfig = z.infer<typeof QueryEngineConfigSchema>

/**
 * A config with every member unset (`null`): nodeop's read mode and the
 * plugin's limits all left to their own defaults — the value a caller
 * starts from, and the one an API node gets when nothing is set.
 *
 * @returns A fresh all-unset config.
 */
export function createUnsetQueryEngineConfig(): QueryEngineConfig {
  return {
    readMode: null,
    workerThreads: null,
    maxInFlight: null,
    maxQueryBytes: null,
    timeoutMs: null,
    maxCaptureMs: null,
    maxAbiBytes: null,
    maxScanRows: null,
    maxRawBytes: null,
    maxMemoryBytes: null,
    maxGroups: null,
    maxResultRows: null,
    maxResponseBytes: null
  }
}

/** Caller options: every member optional; `QueryEngineConfigProvider.resolve` fills the rest with `null`. */
export type QueryEngineOptions = Partial<QueryEngineConfig>
