import { Either } from "@3fv/prelude-ts"
import { defaults } from "lodash"
import { match } from "ts-pattern"

import {
  ConnectionProfile,
  QueryEngineClient,
  SchemaCatalog,
  type QueryEngineClientOptions,
  type SchemaCatalogOptions
} from "@wireio/ql-shared"
import { ConnectionProfileStore, QueryHistoryStore, SavedQueryStore } from "@wireio/ql-shared/node"

import type { ConnectionOptions, QueryTextSource } from "../args/index.js"
import { ConnectionArgs } from "../args/index.js"
import { QLExitCode, QLUsageError } from "../exit/index.js"

/** Where query text is piped from (resolved lazily — process stdin is only touched when needed). */
export interface CliInputOptions {
  /** stdin for piped queries. */
  stdin?: NodeJS.ReadableStream
  /** Whether stdin is a terminal (never read implicitly then). */
  stdinIsTTY?: boolean
}

/** What a wql run needs from its environment (all optional; tests inject every member). */
export interface CliContextOptions extends CliInputOptions {
  /** `profiles.json` store. */
  profileStore?: ConnectionProfileStore
  /** `saved-queries.json` store. */
  savedQueryStore?: SavedQueryStore
  /** `history.jsonl` store. */
  historyStore?: QueryHistoryStore
  /** Environment (`WIRE_QL_URL` / `WIRE_QL_PROFILE` seeds). */
  env?: NodeJS.ProcessEnv
  /** Engine-client overrides (tests inject `fetchProvider`). */
  clientOptions?: QueryEngineClientOptions
  /** Catalog overrides (tests inject `chainAPI`). */
  catalogOptions?: SchemaCatalogOptions
}

/** Resolved context configuration (stdin stays lazy — see {@link CliContext.queryTextSource}). */
export interface CliContextConfig extends Required<Omit<CliContextOptions, keyof CliInputOptions>> {}

/**
 * Defaults: the real stores under `QLPaths` and the process environment.
 *
 * @returns The default options.
 */
export function createCliContextDefaultOptions(): Partial<CliContextOptions> {
  return {
    profileStore: new ConnectionProfileStore(),
    savedQueryStore: new SavedQueryStore(),
    historyStore: new QueryHistoryStore(),
    env: process.env,
    clientOptions: {},
    catalogOptions: {}
  }
}

/**
 * Everything a wql command handler resolves against: the shared stores, the
 * connection resolver, client/catalog factories, the query-text source, and the
 * exit code the run ends with (handlers set it; `main` applies it to the process).
 */
export class CliContext {
  /** Resolved configuration. */
  readonly config: CliContextConfig
  /** The exit code of this run (handlers set it; `main` applies it). */
  exitCode: QLExitCode = QLExitCode.success

  /**
   * @param options - Store / environment / client overrides.
   */
  constructor(private readonly options: CliContextOptions = {}) {
    this.config = defaults({ ...options }, createCliContextDefaultOptions()) as CliContextConfig
  }

  /** `profiles.json`. */
  get profileStore(): ConnectionProfileStore {
    return this.config.profileStore
  }

  /** `saved-queries.json`. */
  get savedQueryStore(): SavedQueryStore {
    return this.config.savedQueryStore
  }

  /** `history.jsonl`. */
  get historyStore(): QueryHistoryStore {
    return this.config.historyStore
  }

  /** Where piped query text is read from (process stdin is touched only when no stream was injected). */
  get queryTextSource(): QueryTextSource {
    const { stdin = process.stdin, stdinIsTTY = "isTTY" in stdin && stdin.isTTY === true } = this.options
    return { stdin, stdinIsTTY }
  }

  /**
   * The connection of this run: `--profile` (or `WIRE_QL_PROFILE`) names the
   * base profile; `--url` (or `WIRE_QL_URL` when no profile flag is given) sets
   * the endpoint — alone it is an ad-hoc profile named after the endpoint;
   * otherwise the default profile. Flag overrides (`--timeout-ms`,
   * `--transport-timeout-ms`, `--retries`, `--owners`) apply on top;
   * `ConnectionProfileDefaults` fill the rest.
   *
   * @param options - The parsed connection flags.
   * @returns The validated profile.
   * @throws QLUsageError when no connection is configured or a value is invalid.
   */
  resolveProfile(options: ConnectionOptions): ConnectionProfile {
    const { env } = this.config,
      { profile: profileFlag, url: urlFlag } = options,
      profileName = profileFlag ?? CliContext.environmentValue(env, ConnectionArgs.ProfileEnvVar),
      url = urlFlag ?? (profileFlag == null ? CliContext.environmentValue(env, ConnectionArgs.UrlEnvVar) : undefined),
      base = match<string, ConnectionProfile>(profileName)
        .when(() => profileName != null, () =>
          Either.try(() => this.profileStore.assertProfile(profileName))
            .ifLeft(error => {
              throw new QLUsageError(`unknown profile ${profileName}; list them with \`wql profiles list\``, {
                cause: error
              })
            })
            .getOrThrow()
        )
        .when(() => url == null, () => this.profileStore.defaultProfile())
        .otherwise(() => undefined)
    if (base == null && url == null) {
      throw new QLUsageError(
        `no connection: pass --url <endpoint> or --profile <name>, or add one with \`wql profiles add <name> <endpoint> --default\``
      )
    }
    return Either.try(() =>
      ConnectionProfile.create({
        ...(base ?? { name: url, endpoint: url }),
        ...(url != null && { endpoint: url }),
        ...ConnectionArgs.profileOverrides(options)
      })
    )
      .ifLeft(error => {
        throw new QLUsageError("invalid connection settings", { cause: error, context: { url, profile: profileName } })
      })
      .getOrThrow()
  }

  /**
   * An engine client for a profile.
   *
   * @param profile - The connection.
   * @returns The client.
   */
  createClient(profile: ConnectionProfile): QueryEngineClient {
    return new QueryEngineClient(profile, this.config.clientOptions)
  }

  /**
   * A schema catalog for a profile.
   *
   * @param profile - The connection.
   * @returns The catalog (its describe probes use a client of the same profile).
   */
  createCatalog(profile: ConnectionProfile): SchemaCatalog {
    return new SchemaCatalog(profile, this.createClient(profile), this.config.catalogOptions)
  }
}

/** Context helpers. */
export namespace CliContext {
  /**
   * An environment seed; an empty value (`WIRE_QL_PROFILE=`) counts as unset.
   *
   * @param env - The environment.
   * @param name - The variable.
   * @returns The value, or undefined when unset or empty.
   */
  export function environmentValue(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name]
    return value == null || value.length === 0 ? undefined : value
  }
}
