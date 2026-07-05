/**
 * Shared cluster type definitions.
 *
 * These shapes describe the on-disk JSON files produced by the `harness`
 * ClusterManager (`cluster-config.json` + `cluster-state.json`). They
 * live in `debugging-shared` so that external tooling — the debugging
 * server, the TUI client, and any third-party inspector — can consume
 * them without pulling in the full harness runtime.
 */

import type { TokenAmount } from "@wireio/opp-typescript-models"

/**
 * Harness-local (chain, token) amount tuple. The previous proto-emitted
 * `ChainTokenAmount` was removed in the v6 data-model refactor — `Token.code`
 * is globally unique now, so the proto carries `TokenAmount` (just
 * `token_code` + `amount`) without a redundant chain tag. We still need the
 * chain dimension at the harness layer (per-underwriter collateral fans out
 * across `{ETH, SOL, WIRE}`), so this local shape pairs each `TokenAmount`
 * with its `chain_code` (slug_name / uint64).
 *
 * Persisted through `cluster-config.json` — `amount.amount` is `bigint`,
 * which `JSON.stringify` cannot serialise natively. {@link
 * serializeClusterConfig} / {@link deserializeClusterConfig} project the
 * field through the proto `TokenAmount`'s JSON helpers so the int64 round-
 * trips losslessly as a string.
 */
export interface ChainTokenAmount {
  /** SlugName / uint64 chain identifier (e.g. `SlugName.from("ETHEREUM")`). */
  chain_code: number
  /** Token amount carrying its own slug_name + int64 amount. */
  amount: TokenAmount
}

// ---------------------------------------------------------------------------
// Cluster filenames
// ---------------------------------------------------------------------------

/**
 * On-disk filenames for a cluster directory. The TUI and any other
 * out-of-process tooling read these to discover a cluster's config and
 * runtime state.
 */
export namespace ClusterFiles {
  /** Resolved cluster config written by `wire-cluster-tool create`. */
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
 * exact argv the harness launches the process with on `wire-cluster-tool run`.
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
   * that exercise termination-via-miss (flow-batch-operator-termination) shrink this to 2 so termcheck
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

  /**
   * Per-underwriter collateral to deposit during bootstrap. Resolved by
   * `loadUnderwriterCollateral` from the optional CLI flag
   * `--underwriter-collateral-json-file`, or filled with defaults
   * (`1000` base units of each integrated outpost's default token, plus
   * WIRE) when omitted.
   *
   * Shape: always a length-`underwriterCount` array of per-underwriter
   * {@link ChainTokenAmount} lists. The "uniform" CLI input (single
   * `Array<ChainTokenAmount>`) is fan-out-expanded to the same value
   * for every underwriter at load time, so the bootstrap step sees a
   * single canonical shape regardless of which CLI form the operator
   * used.
   *
   * Each entry pairs `chain_code` (slug_name / uint64) with a proto-generated
   * `TokenAmount` (carrying its own `token_code` + `bigint` amount); the
   * persistence layer round-trips the amount through `TokenAmount.toJson` /
   * `TokenAmount.fromJson` so the int64 amount survives the JSON boundary.
   */
  underwriterCollateral?: ChainTokenAmount[][]

  /**
   * Overrides for the `sysio::setemitcfg` payload pushed during Phase 15b.
   * Any field omitted falls back to the value in
   * `cluster-tool/src/cluster/constants.ts::EMISSION_CONFIG_DEFAULTS`
   * (which mirrors the wire-sysio `setemitcfg_with_cadence` fixture).
   *
   * Pure JSON-friendly numbers — the depot's `sysio.system::setemitcfg`
   * accepts `int64` for the magnitude fields, JSON.stringify preserves
   * those exactly when they're within `Number.MAX_SAFE_INTEGER`.
   * Flow tests that need values outside that range (e.g. > 9e15) must
   * pass an alternate Phase-15b override path; today's defaults stay
   * inside the safe range.
   */
  emissionConfig?: Partial<EmissionConfigOverrides>

  /** All port assignments for the cluster. Resolved during create, persisted for run. */
  ports: ClusterPorts

  executables: ClusterExePaths
}

/**
 * Per-(chain, token) collateral requirement triple. Mirrors the depot's
 * `sysio.opreg::chain_min_bond` row, which in the v6 data model is keyed
 * by `chain_code` + `token_code` codenames (uint64 packed). Declared with
 * primitive `number` fields so `debugging-shared` stays free of any
 * model-package dependency — callers compute slug_name values via
 * `SlugName.from("ETH")` etc. from `@wireio/sdk-core`.
 */
/**
 * Per-cluster emission config knobs exposed for flow-test overrides.
 *
 * Mirrors the `sysio::setemitcfg` action payload (post wire-sysio PR #354 —
 * no `capital_bps`; implicit capital reserve = `10000 - compute - capex -
 * governance`). The full type lives in
 * `cluster-tool/src/cluster/constants.ts::EmissionConfig`; this
 * dependency-free copy keeps `debugging-shared` free of model deps while
 * letting `ClusterConfig.emissionConfig` carry a partial override.
 *
 * Values are pure JSON numbers; magnitudes fit inside
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1 = ~9e15) for every field that the
 * default fixture exercises. Flow tests that need wider ranges should
 * bypass this surface and call `sysio::setemitcfg` directly.
 */
export interface EmissionConfigOverrides {
  t1_allocation: number
  t2_allocation: number
  t3_allocation: number
  t1_duration: number
  t2_duration: number
  t3_duration: number
  min_claimable: number
  t5_distributable: number
  t5_floor: number
  target_annual_decay_bps: number
  annual_initial_emission: number
  annual_max_emission: number
  annual_min_emission: number
  compute_bps: number
  capex_bps: number
  governance_bps: number
  producer_bps: number
  batch_op_bps: number
  standby_end_rank: number
  epoch_log_retention_count: number
  pay_cadence_epochs: number
}

export interface ChainMinBond {
  /** SlugName / uint64 chain identifier (e.g. `SlugName.from("ETHEREUM")`). */
  chainCode: number
  /** SlugName / uint64 token identifier (e.g. `SlugName.from("ETH")`). */
  tokenCode: number
  /**
   * Minimum bond in the token's base units (lamports for SOL, wei for
   * ETH, etc.). Compared against `sysio.opreg::available(account,
   * chain_code, token_code)` for each non-bootstrapped operator.
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
