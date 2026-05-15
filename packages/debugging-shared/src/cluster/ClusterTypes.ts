/**
 * Shared cluster type definitions.
 *
 * These shapes describe the on-disk JSON files produced by the `harness`
 * ClusterManager (`cluster-config.json` + `cluster-state.json`). They
 * live in `debugging-shared` so that external tooling — the debugging
 * server, the TUI client, and any third-party inspector — can consume
 * them without pulling in the full harness runtime.
 */

// ---------------------------------------------------------------------------
// Cluster filenames
// ---------------------------------------------------------------------------

/**
 * On-disk filenames for a cluster directory. The TUI and any other
 * out-of-process tooling read these to discover a cluster's config and
 * runtime state.
 */
export namespace ClusterFiles {
  /** Resolved cluster config written by `wire-test-cluster create`. */
  export const ConfigFilename = "cluster-config.json" as const
  /** Serialized cluster state written after bootstrap. Hidden dotfile. */
  export const StateFilename = "cluster-state.json" as const
}

// ---------------------------------------------------------------------------
// Executables
// ---------------------------------------------------------------------------

/** Absolute paths to the binaries a cluster needs to run. */
export interface ClusterExePaths {
  nodeop: string
  kiod: string
  clio: string
  sysUtil: string
  anvil: string
  solanaTestValidator: string
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** All ports claimed by a running cluster. Serialized into cluster-config.json. */
export interface ClusterPorts {
  /** kiod wallet daemon HTTP */
  kiod: number
  /** Bios node HTTP (only used during create bootstrap) */
  biosHttp: number
  /** Bios node P2P */
  biosP2p: number
  /** Producer node HTTP ports (one per node) */
  producerHttp: number[]
  /** Producer node P2P ports (one per node) */
  producerP2p: number[]
  /** Batch operator HTTP ports (one per node) */
  batchOperatorHttp: number[]
  /** Batch operator P2P ports (one per node) */
  batchOperatorP2p: number[]
  /** Underwriter HTTP ports (one per node) */
  underwriterHttp: number[]
  /** Underwriter P2P ports (one per node) */
  underwriterP2p: number[]
  /** Anvil (ETH) RPC */
  anvil: number
  /** Solana test validator RPC */
  solanaRpc: number
  /** Solana faucet */
  solanaFaucet: number
  /** Debugging server HTTP */
  debuggingServer: number
}

// ---------------------------------------------------------------------------
// Node role + state
// ---------------------------------------------------------------------------

/** Role a cluster node plays — drives its command line and bootstrap steps. */
export enum NodeRole {
  Producer = "producer",
  BatchOperator = "batch_operator",
  Underwriter = "underwriter"
}

/**
 * Cryptographic material persisted alongside a node's bootstrap state.
 *
 * All values use Wire's canonical string spelling (`PUB_K1_*`, `PVT_K1_*`,
 * `PUB_ED_*`, `PVT_ED_*`, `SIG_BLS_*`) so they round-trip through
 * `@wireio/sdk-core`'s `PrivateKey.from(str)` / `PublicKey.from(str)`
 * without any chain-specific byte reshaping. The harness needs these on
 * disk so that `attach`-mode flow tests can reconstruct the same signing
 * identities the original bootstrap produced — `kiod`'s wallet is the
 * source of truth at runtime, but it isn't queryable for raw private
 * material.
 *
 * ETH-side material is intentionally absent: ETH wallets are derived
 * deterministically from `ETHBootstrapper.AnvilMnemonic + HD index`, so
 * there's no entropy worth persisting.
 */
export interface OperatorNodeKeyMaterial {
  /**
   * WIRE-chain K1 signing key — required for every operator node, used to
   * sign transactions on the depot's WIRE chain.
   */
  wireK1: { publicKey: string; privateKey: string }
  /**
   * BLS finalizer key + proof-of-possession — present on nodes
   * registered as producers / finalizers. Underwriter + batch-operator
   * nodes also receive one because the bootstrap pre-creates the material
   * even when they don't currently sign blocks.
   */
  wireBls?: {
    publicKey: string
    privateKey: string
    proofOfPossession: string
  }
  /**
   * Solana ED25519 key — present on batch-operator nodes when the cluster
   * was bootstrapped with a Solana outpost. Matches the key linked via
   * `sysio.authex::createlink` (`linkOperatorChainAccounts`) and the key
   * configured on the node's `sol-<account>` signature provider.
   */
  solEd?: { publicKey: string; privateKey: string }
}

/**
 * Snapshot of a single cluster node written to state.json. `cmd` is the
 * exact argv the harness launches the process with on `wire-test-cluster run`.
 */
export interface NodeState {
  nodeId: string | number
  host: string
  port: number
  dataPath: string
  configPath: string
  cmd: string[]
  isProducer: boolean
  producerName: string | null
  role?: NodeRole
  operatorAccount?: string
  /**
   * Cryptographic material — populated for operator nodes (batch ops +
   * underwriters) during bootstrap so flow tests can reconstruct the same
   * signing identities in attach mode. See {@link OperatorNodeKeyMaterial}.
   */
  keys?: OperatorNodeKeyMaterial
}

/**
 * Solana anchor program deployed onto the test validator via --bpf-program.
 * Each entry corresponds to one `--bpf-program <programId> <soFile>` pair.
 */
export interface SolanaProgramDeployment {
  name: string
  programId: string
  soFile: string
}

// ---------------------------------------------------------------------------
// Top-level cluster shapes
// ---------------------------------------------------------------------------

/** Input shape for `ClusterManager` — resolved during `create` and persisted. */
export interface ClusterConfig {
  buildPath: string
  clusterPath: string
  walletPath: string
  dataPath: string
  producerCount: number
  nodeCount: number
  httpSecure: boolean
  extraPlugins?: string[]
  batchOperatorCount: number
  underwriterCount: number

  /** Path to wire-ethereum repo root. If omitted, anvil is not configured. */
  ethereumPath: string

  /**
   * Path to wire-solana repo root. If omitted, solana-test-validator is not
   * bootstrapped and the SOL outpost is skipped.
   */
  solanaPath: string

  /** Epoch duration in seconds (default: 360). */
  epochDurationSec: number
  /** Number of epochs an operator waits in WARMUP before becoming ACTIVE. */
  warmupEpochs: number
  /** Number of epochs an operator waits in COOLDOWN before deregistering. */
  cooldownEpochs: number

  /**
   * Per-batch-op rolling-window threshold for `sysio.opreg::termcheck`. Tests
   * that exercise termination-via-miss (flow-e) shrink this to 2 so termcheck
   * fires inside the test budget; production-shaped clusters keep the
   * default 5.
   */
  terminateMaxConsecutiveMisses?: number

  /**
   * Trailing-window miss-rate threshold (percent) for `sysio.opreg::termcheck`.
   * Defaults to 5 (matches `DEFAULT_TERMINATE_MAX_PCT_MISSES_24H` on the
   * depot). Tests rarely need to override.
   */
  terminateMaxPctMisses24H?: number

  /**
   * Wall-clock width of the rolling miss window in milliseconds. Defaults to
   * 24h (matches `DEFAULT_TERMINATE_WINDOW_MS` on the depot). Tests that
   * compress epochs shrink this so the window covers the test runtime.
   */
  terminateWindowMs?: number

  /**
   * Per-role collateral requirements installed by the bootstrap
   * `sysio.opreg::setconfig` call. Each entry binds a `(chain,
   * tokenKind, minBond)` triple; an operator of the matching role must
   * have at least `minBond` of `tokenKind` available on `chain` before
   * the depot's eligibility predicate flips status to ACTIVE.
   *
   * Bootstrapped operators are ACTIVE-by-fiat and bypass these
   * requirements; the vectors only gate **non-bootstrapped** operators.
   * Leave any vector unset (or empty) to disable the requirement for
   * that role — flow tests that don't exercise the eligibility gate
   * skip them.
   */
  reqProdCollat?: ChainMinBond[]
  reqBatchopCollat?: ChainMinBond[]
  reqUwCollat?: ChainMinBond[]

  /** All port assignments for the cluster. Resolved during create, persisted for run. */
  ports: ClusterPorts

  executables: ClusterExePaths
}

/**
 * Per-(chain, token_kind) collateral requirement triple. Mirrors the
 * depot's `sysio.opreg::chain_min_bond` row. Declared with primitive
 * `number` fields so `debugging-shared` stays free of an
 * `@wireio/opp-typescript-models` dependency — callers pass the proto
 * enum values directly (e.g. `ChainKind.SOLANA`, `TokenKind.SOL`).
 */
export interface ChainMinBond {
  /** ChainKind discriminant — see `@wireio/opp-typescript-models`. */
  chain: number
  /** TokenKind discriminant — see `@wireio/opp-typescript-models`. */
  tokenKind: number
  /**
   * Minimum bond in the token's base units (lamports for SOL, wei for
   * ETH, etc.). Compared against `sysio.opreg::available(account,
   * chain, token_kind)` for each non-bootstrapped operator.
   */
  minBond: number
}

/**
 * Post-bootstrap snapshot of cluster runtime layout. Written by the harness
 * after `create` completes and reloaded on subsequent `run` invocations.
 */
export interface ClusterState {
  pnodes: number
  totalNodes: number
  prodCount: number
  topo: string
  nodes: NodeState[]
  batchOperatorNodes: NodeState[]
  underwriterNodes: NodeState[]
  anvilStatePath: string
  solanaLedgerPath: string
  walletPath: string
  /** Anchor programs deployed on the test validator, injected via `--bpf-program`. */
  solanaPrograms?: SolanaProgramDeployment[]
  /** Absolute path of the primary IDL shared with batch operators. */
  solanaIdlPath?: string
}
