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
  formatBLSSignatureProvider,
} from "./keyGen.js"

/** Options for building a start.cmd command. */
export interface StartCmdOptions {
  /** Path to nodeop binary */
  nodeopBinary: string
  /** Blocks directory (relative, usually "blocks") */
  blocksDir?: string
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
  configDir: string
  /** Data directory */
  dataDir: string
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

/**
 * Build the full nodeop command-line arguments matching the Python launcher's
 * `construct_command_line()` output.
 */
export function buildStartCmd(opts: StartCmdOptions): string[] {
  const args: string[] = [opts.nodeopBinary]

  args.push("--blocks-dir", opts.blocksDir ?? "blocks")
  args.push("--p2p-listen-endpoint", opts.p2pListenEndpoint)
  args.push("--p2p-server-address", opts.p2pServerAddress)

  for (const peer of opts.p2pPeerAddresses) {
    args.push("--p2p-peer-address", peer)
  }

  if (opts.enableStaleProduction) {
    args.push("--enable-stale-production")
  }

  // Plugins — net and chain_api are always loaded
  args.push("--plugin", "sysio::net_plugin")
  args.push("--plugin", "sysio::chain_api_plugin")

  // Producer plugin if there are producers assigned
  if (opts.producerNames.length > 0) {
    args.push("--plugin", "sysio::producer_plugin")

    // Signature providers — K1
    for (const k1 of opts.k1Keys) {
      args.push("--signature-provider", formatK1SignatureProvider(k1))
    }
    // Signature providers — BLS
    for (const bls of opts.blsKeys) {
      args.push("--signature-provider", formatBLSSignatureProvider(bls))
    }

    // Producer names
    for (const name of opts.producerNames) {
      args.push("--producer-name", name)
    }
  }

  // Standard nodeop args (matches Python cluster_manager.py nodeop_args)
  args.push("--vote-threads", String(opts.voteThreads ?? 4))
  args.push("--max-transaction-time", String(opts.maxTransactionTime ?? -1))
  args.push("--abi-serializer-max-time-ms", String(opts.abiSerializerMaxTimeMs ?? 990000))
  args.push("--p2p-max-nodes-per-host", String(opts.p2pMaxNodesPerHost ?? 1))
  args.push("--max-clients", String(opts.maxClients ?? 25))
  args.push("--connection-cleanup-period", String(opts.connectionCleanupPeriod ?? 15))

  if (opts.contractsConsole !== false) {
    args.push("--contracts-console")
  }

  args.push("--plugin", "sysio::producer_api_plugin")
  args.push("--plugin", "sysio::trace_api_plugin")
  args.push("--trace-no-abis")
  args.push("--http-max-response-time-ms", String(opts.httpMaxResponseTimeMs ?? 990000))

  // Directories
  args.push("--config-dir", opts.configDir)
  args.push("--data-dir", opts.dataDir)
  args.push("--genesis-json", opts.genesisJson)
  args.push("--genesis-timestamp", opts.genesisTimestamp)

  // HTTP
  args.push("--http-server-address", opts.httpServerAddress)

  // Extra args
  if (opts.extraArgs) {
    args.push(...opts.extraArgs)
  }

  return args
}

/**
 * Build the start.cmd content string (single line, space-separated).
 */
export function buildStartCmdString(opts: StartCmdOptions): string {
  return buildStartCmd(opts).join(" ")
}

/**
 * Build a relaunch command from a saved start.cmd.
 * Strips --genesis-json and --genesis-timestamp, adds --enable-stale-production.
 */
export function buildRelaunchCmd(originalCmd: string[]): string[] {
  const cmd: string[] = []
  let skipNext = false

  for (const arg of originalCmd) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (arg === "--genesis-json" || arg === "--genesis-timestamp") {
      skipNext = true
      continue
    }
    cmd.push(arg)
  }

  if (!cmd.includes("--enable-stale-production")) {
    cmd.push("--enable-stale-production")
  }

  return cmd
}
