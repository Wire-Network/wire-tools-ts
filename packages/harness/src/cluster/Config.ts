/**
 * config.ini generation for Wire nodeop instances.
 *
 * Mirrors the config file structure produced by the Python launcher's
 * `construct_command_line()` and cluster_manager's HTTP-insecure patch.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigOptions {
  /** Plugins to load (e.g. "sysio::net_plugin"). */
  plugins: readonly string[]

  /** P2P listen endpoint (e.g. "0.0.0.0:9876"). */
  p2pListenEndpoint: string

  /** P2P server address advertised to peers (e.g. "localhost:9876"). */
  p2pServerAddress: string

  /** P2P peer addresses to connect to. */
  p2pPeerAddresses?: readonly string[]

  /** HTTP server address (e.g. "0.0.0.0:8888"). */
  httpServerAddress: string

  /** Producer account names scheduled on this node. */
  producerNames?: readonly string[]

  /**
   * Signature providers.  Each string follows the nodeop format:
   *   `wire-<pubkey>,wire,wire,<pubkey>,KEY:<privkey>`
   */
  signatureProviders?: readonly string[]

  /** Agent name for the P2P network. */
  agentName?: string

  /** Chain state database size in MiB. */
  chainStateDbSizeMb?: number

  /** Blocks directory name (relative to data-dir). */
  blocksPath?: string

  /** Enable stale production (bios node). */
  enableStaleProduction?: boolean

  /** Maximum storage for transaction retry (GB). */
  transactionRetryMaxStorageSizeGb?: number

  /** Skip transaction signatures. */
  skipTransactionSignatures?: boolean

  /** Enable contracts console output. */
  contractsConsole?: boolean

  /** Disable trace ABIs. */
  traceNoAbis?: boolean

  /** Maximum P2P connections from a single host. */
  p2pMaxNodesPerHost?: number

  /** Maximum connected clients. */
  maxClients?: number

  /** P2P connection cleanup period (seconds). */
  connectionCleanupPeriod?: number

  /** HTTP max response time (ms). */
  httpMaxResponseTimeMs?: number

  /** ABI serializer max time (ms). */
  abiSerializerMaxTimeMs?: number

  /** Maximum transaction time (ms, -1 for unlimited). */
  maxTransactionTime?: number

  /** Vote threads count. */
  voteThreads?: number

  /** Add permissive CORS / HTTP settings (access-control-allow-origin=*, etc.). */
  httpInsecure?: boolean

  // -- OPP operator node options --

  /** Read mode: "speculative" | "head" | "irreversible". */
  readMode?: "speculative" | "head" | "irreversible"

  /** Batch operator account name. */
  batchOperatorAccount?: string

  /** Batch epoch poll interval (ms). */
  batchEpochPollMs?: number

  /** Batch outpost poll interval (ms). */
  batchOutpostPollMs?: number

  /** Batch delivery timeout (ms). */
  batchDeliveryTimeoutMs?: number

  /** Enable batch operator functionality. */
  batchEnabled?: boolean

  /** Underwriter account name. */
  underwriterAccount?: string

  /** Enable underwriter functionality. */
  underwriterEnabled?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kv(key: string, value: string | number | boolean): string {
  return `${key} = ${String(value)}`
}

function comment(text: string): string {
  return `# ${text}`
}

// ---------------------------------------------------------------------------
// HTTP insecure block (mirrors _HTTP_INSECURE_CONFIG in cluster_manager.py)
// ---------------------------------------------------------------------------

const HTTP_INSECURE_LINES: readonly string[] = [
  "",
  comment("-- http-insecure settings (cluster_manager) --"),
  comment(
    "Specify the Access-Control-Allow-Origin to be returned on each request (sysio::http_plugin)"
  ),
  kv("access-control-allow-origin", "*"),
  comment(
    "Specify the Access-Control-Allow-Headers to be returned on each request (sysio::http_plugin)"
  ),
  kv("access-control-allow-headers", "*"),
  comment("Append the error log to HTTP responses (sysio::http_plugin)"),
  kv("verbose-http-errors", "true"),
  comment(
    'If set to false, then any incoming "Host" header is considered valid (sysio::http_plugin)'
  ),
  kv("http-validate-host", "false")
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a config.ini string for a nodeop instance.
 *
 * The output matches the format written by the Python launcher and
 * cluster_manager.
 */
export function generateConfigFileContent(opts: ConfigOptions): string {
  return [
    // Plugins
    ...opts.plugins.map(plugin => kv("plugin", plugin)),
    "",

    // Networking
    kv("p2p-listen-endpoint", opts.p2pListenEndpoint),
    kv("p2p-server-address", opts.p2pServerAddress),
    kv("http-server-address", opts.httpServerAddress),
    ...(opts.p2pPeerAddresses?.map(peer => kv("p2p-peer-address", peer)) ?? []),
    "",

    // Blocks
    opts.blocksPath && kv("blocks-dir", opts.blocksPath),

    // Producer
    opts.enableStaleProduction && kv("enable-stale-production", "true"),
    ...(opts.producerNames?.map(n => kv("producer-name", n)) ?? []),
    ...(opts.signatureProviders?.map(sp => kv("signature-provider", sp)) ?? []),
    opts.transactionRetryMaxStorageSizeGb &&
      kv(
        "transaction-retry-max-storage-size-gb",
        opts.transactionRetryMaxStorageSizeGb
      ),
    "",

    // Agent & chain state
    opts.agentName && kv("agent-name", `"${opts.agentName}"`),
    opts.chainStateDbSizeMb &&
      kv("chain-state-db-size-mb", opts.chainStateDbSizeMb),

    // Misc flags
    opts.skipTransactionSignatures && kv("skip-transaction-signatures", "true"),
    opts.contractsConsole && kv("contracts-console", "true"),
    opts.traceNoAbis && kv("trace-no-abis", ""),

    // Limits
    opts.p2pMaxNodesPerHost &&
      kv("p2p-max-nodes-per-host", opts.p2pMaxNodesPerHost),
    opts.maxClients && kv("max-clients", opts.maxClients),
    opts.connectionCleanupPeriod &&
      kv("connection-cleanup-period", opts.connectionCleanupPeriod),
    opts.httpMaxResponseTimeMs &&
      kv("http-max-response-time-ms", opts.httpMaxResponseTimeMs),
    opts.abiSerializerMaxTimeMs &&
      kv("abi-serializer-max-time-ms", opts.abiSerializerMaxTimeMs),
    opts.maxTransactionTime &&
      kv("max-transaction-time", opts.maxTransactionTime),
    opts.voteThreads && kv("vote-threads", opts.voteThreads),

    // Read mode
    opts.readMode && kv("read-mode", opts.readMode),

    // OPP batch operator
    opts.batchOperatorAccount &&
      kv("batch-operator-account", opts.batchOperatorAccount),
    opts.batchEpochPollMs && kv("batch-epoch-poll-ms", opts.batchEpochPollMs),
    opts.batchOutpostPollMs &&
      kv("batch-outpost-poll-ms", opts.batchOutpostPollMs),
    opts.batchDeliveryTimeoutMs &&
      kv("batch-delivery-timeout-ms", opts.batchDeliveryTimeoutMs),
    opts.batchEnabled && kv("batch-enabled", opts.batchEnabled),

    // OPP underwriter
    opts.underwriterEnabled &&
      kv("underwriter-enabled", opts.underwriterEnabled),
    opts.underwriterAccount &&
      kv("underwriter-account", opts.underwriterAccount),

    // HTTP insecure block
    ...(opts.httpInsecure ? HTTP_INSECURE_LINES : []),

    "" // trailing newline
  ]
    .filter((s): s is string => typeof s === "string")
    .join("\n")
}
