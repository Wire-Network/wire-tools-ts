/**
 * Generates `start.cmd` scripts for nodeop instances.
 *
 * Mirrors the Python TestHarness/launcher.py `construct_command_line()` method.
 * The start.cmd is a single-line shell command containing ALL nodeop arguments.
 * This is the canonical way nodes are launched — config.ini is just the default
 * template, all active settings come from the command line.
 */

import {
  type NodeKeySet,
  type K1KeyPair,
  type BLSKeyPair,
  formatK1SignatureProvider,
  formatBLSSignatureProvider
} from "./keyGen.js"

/** Options for building a start.cmd command. */
export interface StartCmdOptions {
  /** Path to nodeop binary */
  nodeopBinary: string
  /** Blocks directory (relative, usually "blocks") */
  blocksPath?: string
  /** P2P listen endpoint (e.g. "0.0.0.0:9876") */
  p2pListenEndpoint: string
  /** P2P server address advertised to peers (e.g. "localhost:9876") */
  p2pServerAddress: string
  /** P2P peer addresses to connect to */
  p2pPeerAddresses: string[]
  /** HTTP server address (e.g. "localhost:8888") */
  httpServerAddress: string
  /** Enable stale production (for bios node) */
  enableStaleProduction?: boolean
  /** Producer names assigned to this node */
  producerNames: string[]
  /** K1 key pairs for this node (one per key set) */
  k1Keys: K1KeyPair[]
  /** BLS key pairs for this node */
  blsKeys: BLSKeyPair[]
  /** Config directory */
  configPath: string
  /** Data directory */
  dataPath: string
  /** Path to genesis.json */
  genesisJson: string
  /** Genesis timestamp (ISO format) */
  genesisTimestamp: string
  /** Maximum p2p nodes per host */
  p2pMaxNodesPerHost?: number
  /** Maximum clients */
  maxClients?: number
  /** Connection cleanup period in seconds */
  connectionCleanupPeriod?: number
  /** Vote threads */
  voteThreads?: number
  /** Max transaction time (-1 for unlimited) */
  maxTransactionTime?: number
  /** ABI serializer max time in ms */
  abiSerializerMaxTimeMs?: number
  /** HTTP max response time in ms */
  httpMaxResponseTimeMs?: number
  /** Enable contracts console output */
  contractsConsole?: boolean
  /** Extra nodeop args */
  extraArgs?: string[]
}

/** Nodeop plugins loaded on every node regardless of role. */
const AlwaysOnPlugins = [
  "sysio::net_plugin",
  "sysio::chain_api_plugin"
] as const

/** Nodeop plugins loaded only when the node has producers assigned. */
const ProducerPlugins = ["sysio::producer_plugin"] as const

/** Nodeop plugins loaded after the standard argument block. */
const TrailingPlugins = [
  "sysio::producer_api_plugin",
  "sysio::trace_api_plugin"
] as const

/** `[flag, value]` pair expansion helper. */
const pair = (flag: string, value: string): [string, string] => [flag, value]

/** `--plugin` expansion helper (readonly-array friendly). */
const pluginArgs = (plugins: readonly string[]): string[] =>
  plugins.flatMap(p => pair("--plugin", p))

/**
 * Build the full nodeop command-line arguments matching the Python
 * launcher's `construct_command_line()` output.
 *
 * @param opts - Fully-materialized node config; missing fields take
 *               defaults from {@link buildStartCmd}.
 * @returns Argv array suitable for `spawn(argv[0], argv.slice(1))` or
 *          for joining into a `start.cmd` file.
 */
export function buildStartCmd(opts: StartCmdOptions): string[] {
  const {
    DefaultBlocksPath,
    DefaultVoteThreads,
    DefaultMaxTransactionTime,
    DefaultAbiSerializerMaxTimeMs,
    DefaultP2PMaxNodesPerHost,
    DefaultMaxClients,
    DefaultConnectionCleanupPeriodSec,
    DefaultHttpMaxResponseTimeMs
  } = buildStartCmd

  const hasProducers = opts.producerNames.length > 0

  return [
    opts.nodeopBinary,
    ...pair("--blocks-dir", opts.blocksPath ?? DefaultBlocksPath),
    ...pair("--p2p-listen-endpoint", opts.p2pListenEndpoint),
    ...pair("--p2p-server-address", opts.p2pServerAddress),
    ...opts.p2pPeerAddresses.flatMap(peer => pair("--p2p-peer-address", peer)),
    ...(opts.enableStaleProduction ? ["--enable-stale-production"] : []),
    ...pluginArgs(AlwaysOnPlugins),
    ...(hasProducers
      ? [
          ...pluginArgs(ProducerPlugins),
          ...opts.k1Keys.flatMap(k1 =>
            pair("--signature-provider", formatK1SignatureProvider(k1))
          ),
          ...opts.blsKeys.flatMap(bls =>
            pair("--signature-provider", formatBLSSignatureProvider(bls))
          ),
          ...opts.producerNames.flatMap(name => pair("--producer-name", name))
        ]
      : []),
    ...pair("--vote-threads", String(opts.voteThreads ?? DefaultVoteThreads)),
    ...pair(
      "--max-transaction-time",
      String(opts.maxTransactionTime ?? DefaultMaxTransactionTime)
    ),
    ...pair(
      "--abi-serializer-max-time-ms",
      String(opts.abiSerializerMaxTimeMs ?? DefaultAbiSerializerMaxTimeMs)
    ),
    ...pair(
      "--p2p-max-nodes-per-host",
      String(opts.p2pMaxNodesPerHost ?? DefaultP2PMaxNodesPerHost)
    ),
    ...pair("--max-clients", String(opts.maxClients ?? DefaultMaxClients)),
    ...pair(
      "--connection-cleanup-period",
      String(opts.connectionCleanupPeriod ?? DefaultConnectionCleanupPeriodSec)
    ),
    ...(opts.contractsConsole !== false ? ["--contracts-console"] : []),
    ...pluginArgs(TrailingPlugins),
    "--trace-no-abis",
    ...pair(
      "--http-max-response-time-ms",
      String(opts.httpMaxResponseTimeMs ?? DefaultHttpMaxResponseTimeMs)
    ),
    ...pair("--config-dir", opts.configPath),
    ...pair("--data-dir", opts.dataPath),
    ...pair("--genesis-json", opts.genesisJson),
    ...pair("--genesis-timestamp", opts.genesisTimestamp),
    ...pair("--http-server-address", opts.httpServerAddress),
    ...(opts.extraArgs ?? [])
  ]
}

/**
 * Build the start.cmd content string (single line, space-separated).
 */
export function buildStartCmdString(opts: StartCmdOptions): string {
  return buildStartCmd(opts).join(" ")
}

/**
 * Flags whose `[flag, value]` pair gets stripped by {@link buildRelaunchCmd}.
 * Genesis settings are one-shot: applying them on every relaunch would
 * re-stamp the chain with a new genesis timestamp.
 */
const RelaunchStripFlags: ReadonlySet<string> = new Set([
  "--genesis-json",
  "--genesis-timestamp"
])

/** Flag appended to relaunches so the restarted producer can resume. */
const EnableStaleProductionFlag = "--enable-stale-production"

/**
 * Build a relaunch command from a saved start.cmd.
 *
 * Strips every `[flag, value]` pair whose flag is in
 * {@link RelaunchStripFlags} and idempotently appends
 * {@link EnableStaleProductionFlag}.
 *
 * @param originalCmd - Argv captured at cluster-create time.
 * @returns Argv suitable for relaunch on `wire-test-cluster run`.
 */
export function buildRelaunchCmd(originalCmd: string[]): string[] {
  const stripped = originalCmd.flatMap((arg, i, all) => {
    if (RelaunchStripFlags.has(all[i - 1])) return []
    if (RelaunchStripFlags.has(arg)) return []
    return [arg]
  })

  return stripped.includes(EnableStaleProductionFlag)
    ? stripped
    : [...stripped, EnableStaleProductionFlag]
}

/**
 * Defaults applied when a {@link StartCmdOptions} field is omitted. These
 * mirror the values produced by the Python launcher's
 * `construct_command_line()` — changing one here silently changes the
 * nodeop configuration for every cluster that doesn't override it.
 */
export namespace buildStartCmd {
  export const DefaultBlocksPath = "blocks"
  export const DefaultVoteThreads = 4
  export const DefaultMaxTransactionTime = -1
  export const DefaultAbiSerializerMaxTimeMs = 990_000
  export const DefaultP2PMaxNodesPerHost = 1
  export const DefaultMaxClients = 25
  export const DefaultConnectionCleanupPeriodSec = 15
  export const DefaultHttpMaxResponseTimeMs = 990_000
}
