import Assert from "node:assert"

import { defaults } from "lodash"

import {
  QueryEngineLimitSchema,
  QueryEngineReadModeSchema,
  createUnsetQueryEngineConfig,
  type QueryEngineConfig,
  type QueryEngineLimitKey,
  type QueryEngineOptions
} from "@wireio/cluster-tool-shared"

import { Constants } from "../Constants.js"
import { toIniLine } from "../utils/iniUtils.js"

/**
 * The harness's view of `sysio::query_engine_plugin`'s config: resolves the
 * shape shared by a cluster's API nodes (`ClusterConfigProvider.resolve`) and
 * the standalone `create-api-node` artifact (`ApiNodeConfig.resolve`), and
 * projects it onto ini lines for both renderers. Every member stays `null` —
 * nodeop's / the plugin's own default — unless set.
 */
export namespace QueryEngineConfigProvider {
  /**
   * The default half of a {@link QueryEngineOptions} merge. Every member is
   * `null` on purpose: nodeop (read mode) and the plugin (limits) are the
   * single authors of their defaults.
   *
   * @returns The defaults.
   */
  export function createDefaultOptions(): QueryEngineConfig {
    return createUnsetQueryEngineConfig()
  }

  /**
   * Merge caller options over the defaults and validate: every SET limit
   * satisfies the shared limit schema (a positive safe integer), a SET read
   * mode is one the plugin accepts, and the plugin's two pairwise rules hold
   * whenever BOTH halves of a pair are set — `query-max-capture-ms` never
   * exceeds `query-timeout-ms`, `query-max-raw-bytes` never exceeds
   * `query-max-memory-bytes`. No plugin default is restated: a pair with one
   * unset half is the plugin's to judge at startup, as is its admitted-memory
   * overflow rule.
   *
   * @param options - Caller options (any subset).
   * @returns The resolved config.
   */
  export function resolve(options: QueryEngineOptions = {}): QueryEngineConfig {
    const config: QueryEngineConfig = defaults(
      { ...options },
      createDefaultOptions()
    )
    Constants.QUERY_ENGINE_LIMIT_OPTIONS.forEach(({ member, option }) =>
      Assert.ok(
        QueryEngineLimitSchema.safeParse(config[member]).success,
        `QueryEngineConfig: ${option} must be a positive integer when set — got ${config[member]}`
      )
    )
    Assert.ok(
      QueryEngineReadModeSchema.nullable().safeParse(config.readMode).success,
      `QueryEngineConfig: ${Constants.READ_MODE_OPTION} must be one of ${QueryEngineReadModeSchema.options.join(" | ")} when set — got ${config.readMode}`
    )
    assertPairOrder(config, "maxCaptureMs", "timeoutMs")
    assertPairOrder(config, "maxRawBytes", "maxMemoryBytes")
    return config
  }

  /**
   * The ini footprint of one resolved config: one line per SET member, the
   * read mode first, then the limits in the plugin's order. A `null` member
   * emits nothing. Shared by the cluster ini renderer (API-role nodes) and the
   * standalone API-node renderer, so the two cannot spell an option differently.
   *
   * @param config - The resolved query-engine config.
   * @returns The ini lines (possibly empty).
   */
  export function toIniLines(config: QueryEngineConfig): string[] {
    return [
      ...(config.readMode != null
        ? [toIniLine(Constants.READ_MODE_OPTION, config.readMode)]
        : []),
      ...Constants.QUERY_ENGINE_LIMIT_OPTIONS.flatMap(({ member, option }) =>
        config[member] != null ? [toIniLine(option, config[member])] : []
      )
    ]
  }

  /**
   * The plugin's `lower ≤ upper` rule for one limit pair, checked only when
   * both are set. Each half's value and option name are read off the same
   * member, so the message cannot name a different option than it checked.
   */
  function assertPairOrder(
    config: QueryEngineConfig,
    lower: QueryEngineLimitKey,
    upper: QueryEngineLimitKey
  ): void {
    Assert.ok(
      config[lower] == null ||
        config[upper] == null ||
        config[lower] <= config[upper],
      `QueryEngineConfig: ${optionOf(lower)} (${config[lower]}) must not exceed ${optionOf(upper)} (${config[upper]})`
    )
  }

  /** The nodeop option a limit member renders as, read off the one option table. */
  function optionOf(
    member: QueryEngineLimitKey
  ): Constants.QueryEngineLimitOption["option"] {
    return Constants.QUERY_ENGINE_LIMIT_OPTIONS.find(
      entry => entry.member === member
    ).option
  }
}
