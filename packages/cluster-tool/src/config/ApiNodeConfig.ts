import Assert from "node:assert"
import Fs from "node:fs"
import { DefaultChainStateDbSizeMb } from "@wireio/cluster-tool-shared"
import { defaults } from "lodash"
import { assertEndpoint } from "../utils/netUtils.js"

/**
 * Inputs that stay OPTIONAL after resolution — deliberately kept out of the
 * `Required<>` mirror in {@link ApiNodeConfig}, because "absent" is a real,
 * supported state rather than a value waiting for a default.
 */
export interface ApiNodeGenesisOptions {
  /**
   * nodeop `--genesis-json` passthrough — copied into the output dir; omitted ⇒
   * the operator supplies the chain's data directory or a snapshot instead.
   */
  genesisJsonFile?: string
}

/**
 * The ticket-baseline API-node knobs — genuine per-instance leaves that sit on
 * no domain type, so they ride their own typed group (STYLE.md "Options Compose
 * Domain Types", rule 4) rather than flattening into {@link ApiNodeOptions}.
 */
export interface ApiNodeTuningOptions {
  /**
   * `transaction-finality-status-max-storage-size-gb`. Supplying it is what
   * ENABLES nodeop's finality-status feature (the tracker is off at 0).
   */
  transactionFinalityStatusMaxStorageSizeGb?: number
  /** `enable-account-queries` — the `/v1/chain/get_accounts_by_authorizers` index. */
  enableAccountQueries?: boolean
  /** `http-max-in-flight-requests` — concurrent in-flight HTTP request cap. */
  httpMaxInFlightRequests?: number
  /** `http-threads` — size of the HTTP plugin's thread pool. */
  httpThreads?: number
  /** `agent-name` — the node's advertised p2p handshake name (a net_plugin option). */
  agentName?: string
}

/**
 * Caller input for a STANDALONE (non-cluster) API node — the `create-api-node`
 * surface. Every field is optional per the three-layer options pattern: yargs'
 * `demandOption: true` supplies presence at the CLI, and
 * {@link ApiNodeConfig.resolve} re-asserts it for every other caller.
 */
export interface ApiNodeOptions extends ApiNodeGenesisOptions {
  /** Destination directory for the emitted `config.ini` + `start.sh`. */
  outputPath?: string
  /**
   * nodeop `http-server-address` — the deployment endpoint this node will serve
   * on, used VERBATIM (see {@link ApiNodeConfig} for the port-registry
   * carve-out).
   */
  httpServerAddress?: string
  /** nodeop `p2p-peer-address`, repeatable — one rendered ini line per entry. */
  p2pPeerAddresses?: string[]
  /** nodeop `chain-state-db-size-mb`; defaults to {@link DefaultChainStateDbSizeMb}. */
  chainStateDbSizeMb?: number
  /** The ticket-baseline tuning group; each member defaults independently. */
  tuning?: ApiNodeTuningOptions
}

/**
 * What the renderers require: every {@link ApiNodeOptions} field resolved,
 * except the genuinely-optional {@link ApiNodeGenesisOptions} half, which is
 * re-mixed in unchanged.
 */
export interface ApiNodeConfig
  extends
    Required<Omit<ApiNodeOptions, keyof ApiNodeGenesisOptions>>,
    ApiNodeGenesisOptions {}

/**
 * The resolved defaults for an API node — namespace constants only, never raw
 * values (STYLE.md "No Inline Literals").
 *
 * @returns The default half of an {@link ApiNodeOptions} merge.
 */
export function createApiNodeDefaultOptions(): Partial<ApiNodeOptions> {
  return {
    p2pPeerAddresses: [],
    chainStateDbSizeMb: DefaultChainStateDbSizeMb,
    tuning: {
      transactionFinalityStatusMaxStorageSizeGb:
        ApiNodeConfig.DefaultTransactionFinalityStatusMaxStorageSizeGb,
      enableAccountQueries: ApiNodeConfig.DefaultEnableAccountQueries,
      httpMaxInFlightRequests: ApiNodeConfig.DefaultHttpMaxInFlightRequests,
      httpThreads: ApiNodeConfig.DefaultHttpThreads,
      agentName: ApiNodeConfig.DefaultAgentName
    }
  }
}

/** Every assertion message is prefixed with the config type it came from. */
const AssertionLabel = "ApiNodeConfig"

/** Qualify a field name for an assertion message (`ApiNodeConfig: <field>`). */
const assertionLabelFor = (field: string) => `${AssertionLabel}: ${field}`

/**
 * Assert every invariant a merged config must satisfy before anything is
 * rendered or written. Endpoint shape + port range come from
 * {@link assertEndpoint} — the ONE host/URL authority (`netUtils`).
 *
 * @param config - The post-merge config.
 */
function assertApiNodeConfig(config: ApiNodeConfig): void {
  Assert.ok(
    config.outputPath != null && config.outputPath.length > 0,
    `${assertionLabelFor("outputPath")} is required`
  )
  assertEndpoint(
    config.httpServerAddress,
    assertionLabelFor("httpServerAddress")
  )
  config.p2pPeerAddresses.forEach((peer, index) =>
    assertEndpoint(peer, assertionLabelFor(`p2pPeerAddresses[${index}]`))
  )
  Assert.ok(
    config.chainStateDbSizeMb > 0,
    `${assertionLabelFor("chainStateDbSizeMb")} must be > 0 — got ${config.chainStateDbSizeMb}`
  )
  Assert.ok(
    config.genesisJsonFile == null || Fs.existsSync(config.genesisJsonFile),
    `${assertionLabelFor("genesisJsonFile")} not found at ${config.genesisJsonFile}`
  )
}

/**
 * Companion constants + resolution for {@link ApiNodeConfig}.
 *
 * **Port-registry carve-out.** `--http-server-address` is a USER-SUPPLIED
 * endpoint for an arbitrary deployment host, and it is used verbatim — exactly
 * the carve-out complete external `BindConfig`s already carry: a remote
 * endpoint's port is not this host's to reserve. `create-api-node` binds
 * nothing, starts nothing, and probes nothing, so it makes no
 * `BindConfigProvider` claim — and none may be invented here (the registry
 * exists to keep CONCURRENT CLUSTERS on THIS host from colliding, and there is
 * no local listener to protect). The same applies to every
 * `--p2p-peer-address`: those are remote peers this process only writes into a
 * file.
 */
export namespace ApiNodeConfig {
  /** `transaction-finality-status-max-storage-size-gb` — the ticket baseline. */
  export const DefaultTransactionFinalityStatusMaxStorageSizeGb = 10
  /** `enable-account-queries` — on, so authorizer lookups work out of the box. */
  export const DefaultEnableAccountQueries = true
  /** `http-max-in-flight-requests` — the ticket baseline. */
  export const DefaultHttpMaxInFlightRequests = 100
  /** `http-threads` — the ticket baseline. */
  export const DefaultHttpThreads = 4
  /** `agent-name` — how this node identifies itself in the p2p handshake. */
  export const DefaultAgentName = "wire-api-node"

  /**
   * Merge caller options over {@link createApiNodeDefaultOptions}, then assert
   * every invariant.
   *
   * lodash `defaults` is SHALLOW, so a caller-supplied `tuning` would REPLACE
   * the default group wholesale and silently unset every member it omitted —
   * hence the second, sub-group pass. `defaultsDeep` is deliberately NOT used:
   * it also merges ARRAYS index-by-index, which would resurrect default
   * `p2pPeerAddresses` entries underneath a shorter caller list.
   *
   * @param options - Caller options; every field optional.
   * @returns The fully-resolved, validated config.
   */
  export function resolve(options: ApiNodeOptions = {}): ApiNodeConfig {
    const defaultOptions = createApiNodeDefaultOptions(),
      merged = defaults({ ...options }, defaultOptions) as ApiNodeConfig,
      config: ApiNodeConfig = {
        ...merged,
        tuning: defaults({ ...merged.tuning }, defaultOptions.tuning)
      }
    assertApiNodeConfig(config)
    return config
  }
}
