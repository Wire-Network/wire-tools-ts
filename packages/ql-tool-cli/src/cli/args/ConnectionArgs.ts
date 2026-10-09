import type { Argv } from "yargs"

import { ConnectionProfileDefaults, type ConnectionProfile } from "@wireio/ql-shared"

/** Parsed connection flags — every member optional (undefined = not given; NO yargs defaults). */
export interface ConnectionOptions {
  /** Saved profile name (`--profile`). */
  profile?: string
  /** Ad-hoc endpoint (`--url`). */
  url?: string
  /** Server deadline sent as request `timeout_ms` (`--timeout-ms`). */
  timeoutMs?: number
  /** Client fetch ceiling (`--transport-timeout-ms`). */
  transportTimeoutMs?: number
  /** Auto-retries of server-retryable failures (`--retries`). */
  retries?: number
  /** Owner accounts the schema browser lists (`--owners`). */
  owners?: string[]
}

/** Connection-flag constants and the flag → profile mapping. */
export namespace ConnectionArgs {
  /** Environment variable seeding `--url` (read by the resolver, never as a yargs default). */
  export const UrlEnvVar = "WIRE_QL_URL"
  /** Environment variable seeding `--profile`. */
  export const ProfileEnvVar = "WIRE_QL_PROFILE"

  /**
   * The profile members the tuning flags override — only the flags that were
   * given (`--timeout-ms` → `queryTimeoutMs`, `--transport-timeout-ms`,
   * `--retries`, `--owners`). The ONE mapping of `CliContext.resolveProfile` and
   * `wql profiles add`.
   *
   * @param options - The parsed connection flags.
   * @returns The overriding members (spread over a base profile).
   */
  export function profileOverrides(options: ConnectionOptions): Partial<ConnectionProfile> {
    const { timeoutMs, transportTimeoutMs, retries, owners } = options
    return {
      ...(timeoutMs != null && { queryTimeoutMs: timeoutMs }),
      ...(transportTimeoutMs != null && { transportTimeoutMs }),
      ...(retries != null && { retries }),
      ...(owners != null && { owners })
    }
  }
}

/**
 * Register the connection flags — NO `default:` (defaults resolve once in
 * `CliContext.resolveProfile`).
 *
 * @param builder - The yargs builder.
 * @returns The builder with the flags registered.
 */
export function applyConnectionArgs<T>(builder: Argv<T>) {
  return builder
    .option("profile", {
      alias: "p",
      type: "string",
      describe: `saved connection profile (default: the default profile; env ${ConnectionArgs.ProfileEnvVar})`
    })
    .option("url", {
      alias: "u",
      type: "string",
      describe: `API node endpoint, e.g. http://127.0.0.1:8888 (env ${ConnectionArgs.UrlEnvVar})`
    })
    .option("timeout-ms", {
      type: "number",
      describe: "server deadline sent as timeout_ms; may only lower query-timeout-ms (default: the profile's, else the server's)"
    })
    .option("transport-timeout-ms", {
      type: "number",
      describe: `client fetch ceiling in ms (default ${ConnectionProfileDefaults.TransportTimeoutMs})`
    })
    .option("retries", {
      type: "number",
      describe: `auto-retries of server-retryable failures (default ${ConnectionProfileDefaults.Retries})`
    })
    .option("owners", {
      type: "array",
      string: true,
      describe: "owner accounts the schema browser lists (default: every system contract)"
    })
}
