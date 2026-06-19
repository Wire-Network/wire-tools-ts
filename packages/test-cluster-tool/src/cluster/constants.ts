/**
 * Hardcoded constants extracted from cluster_manager.py and launcher.py.
 *
 * These values mirror the Python originals so the TypeScript harness produces
 * identical cluster configurations.
 */

import { Option } from "@3fv/prelude-ts"

import { Hash, KeyType, PrivateKey, Crypto } from "@wireio/sdk-core"

// ---------------------------------------------------------------------------
// Development key pair (matches genesis bios key)
// ---------------------------------------------------------------------------
const DefaultK1KeyPairSeed = "nathan"

export const DefaultK1KeyPair = Option.try(() => {
  const privKeyDigest = Hash.sha256().update(DefaultK1KeyPairSeed).digest(),
    privateKey = PrivateKey.regenerate(KeyType.K1, privKeyDigest),
    publicKey = privateKey.toPublic()

  return {
    privateKey,
    publicKey,
    privateKeyWIF: privateKey.toWif(),
    publicKeyWIF: publicKey.toLegacyString()
  }
}).getOrThrow(`Failed to create default key pair: ${DefaultK1KeyPairSeed}`)

export type DefaultK1KeyPairType = typeof DefaultK1KeyPair

/** Default sysio development private key (WIF format). */
export const DEV_K1_PRIVATE_KEY = DefaultK1KeyPair.privateKeyWIF

/** Default sysio development public key (SYS prefix). */
export const DEV_K1_PUBLIC_KEY = DefaultK1KeyPair.publicKeyWIF

const DefaultBLSKeyPairSeed = "wire"

export const DefaultBLSKeyPair = Option.try(() => {
  const privKeyDigest = Hash.sha256().update(DefaultBLSKeyPairSeed).digest(),
    privateKey = PrivateKey.regenerate(KeyType.BLS, privKeyDigest),
    publicKey = privateKey.toPublic(),
    proofOfPossession = privateKey.proofOfPossessionSignature,
    proofOfPossessionStr = privateKey.proofOfPossessionString

  return {
    privateKey,
    publicKey,
    proofOfPossession,
    privateKeyStr: privateKey.toString(),
    publicKeyStr: publicKey.toString(),
    proofOfPossessionStr
  }
}).getOrThrow(`Failed to create default BLS key pair: ${DefaultBLSKeyPairSeed}`)

export type DefaultBLSKeyPairType = typeof DefaultBLSKeyPair

/** Default sysio development BLS private key. */
export const DEV_BLS_PRIVATE_KEY = DefaultBLSKeyPair.privateKeyStr

/** Default sysio development BLS public key. */
export const DEV_BLS_PUBLIC_KEY = DefaultBLSKeyPair.publicKeyStr

/** Default sysio development BLS proof of possession. */
export const DEV_BLS_PROOF_OF_POSSESSION =
  DefaultBLSKeyPair.proofOfPossessionStr

/**
 * Formats a signature-provider config value matching the Wire nodeop format:
 * `<name>,<chain-kind>,<key-type>,<public-key>,KEY:<private-key>`
 *
 * @param name - Provider name (e.g., "wire-SYS6MRy...")
 * @param chainKind - Chain kind string: "wire", "ethereum", "solana"
 * @param keyType - Key type string: "wire", "wire_bls", "ethereum", "solana"
 * @param publicKey - Public key string
 * @param privateKey - Private key string
 * @returns Formatted signature-provider spec
 */
export function formatSignatureProvider(
  name: string,
  chainKind: string,
  keyType: string,
  publicKey: string,
  privateKey: string
): string {
  return `${name},${chainKind},${keyType},${publicKey},KEY:${privateKey}`
}

/**
 * Generates the default dev signature-provider spec for WIRE chain.
 * Matches the Python launcher format: `wire-<pubkey>,wire,wire,<pubkey>,KEY:<privkey>`
 */
export function devSignatureProvider(): string {
  return formatSignatureProvider(
    `wire-${DEV_K1_PUBLIC_KEY}`,
    "wire",
    "wire",
    DEV_K1_PUBLIC_KEY,
    DEV_K1_PRIVATE_KEY
  )
}

// ---------------------------------------------------------------------------
// System account names (created during bootstrap)
// ---------------------------------------------------------------------------

export const SYSTEM_ACCOUNTS = [
  "sysio.noop",
  "sysio.bpay",
  "sysio.msig",
  "sysio.names",
  "sysio.token",
  "sysio.vpay",
  "sysio.wrap",
  "sysio.roa",
  "sysio.acct",
  "sysio.authex",
  "sysio.chains",
  "sysio.tokens",
  "sysio.epoch",
  "sysio.opreg",
  "sysio.msgch",
  "sysio.uwrit",
  "sysio.reserv",
  "sysio.chalg",
  // Capital / dclaim contract account. Also serves as the
  // CAPITAL_ACCOUNT recipient for emissions `fundclaim` transfers and the
  // per-staker `STAKING_REWARD` claim ledger.
  "sysio.dclaim",
  // T5 governance bucket (recipient of governance_bps split in payepoch).
  "sysio.gov",
  // T5 capex / operations bucket (recipient of capex_bps split in payepoch).
  "sysio.ops",
  "dev.owner1"
] as const

export type SystemAccountName = (typeof SYSTEM_ACCOUNTS)[number]

// ---------------------------------------------------------------------------
// Token parameters
// ---------------------------------------------------------------------------

/** Maximum token supply: 1 billion. */
export const TOKEN_MAX_SUPPLY = "1000000000.0000 SYS"

/** Initial funds transferred to each producer account. */
export const PRODUCER_INITIAL_FUNDS = "1000000.0000 SYS"

/** Core symbol precision and name (e.g. "4,SYS"). */
export const CORE_SYMBOL_SPEC = "4,SYS"

/** Core symbol name only. */
export const CORE_SYMBOL = "SYS"

/** Core symbol decimal precision. */
export const CORE_SYMBOL_PRECISION = 4

// ---------------------------------------------------------------------------
// ROA (Resource Ownership & Allocation) parameters
// ---------------------------------------------------------------------------

/**
 * `total_sys` passed to `sysio.roa::activateroa` — the supply the ROA RAM pool is sized from.
 *
 * The contract converts this asset's SMALLEST units to bytes: total RAM = `amount * bytes_per_unit`
 * = `754,960,000 * 104` ≈ 78.5 GB. The tier reserves consume a fixed ~99.6% of supply (per node T1 4% ×
 * 21, T2 0.15% × 84, T3 0.003% × 1000), leaving ~0.4% (~314 MB) split between `sysio.roa` and the `sysio`
 * bootstrap pool. The split is ratiometric, but the bytes are real, so this is tuned just large enough that
 * the leftover pool clears the bootstrap's fixed RAM costs (each contract's code/abi + `newaccount_ram`).
 * See `docs/production-bootstrap.md`.
 */
export const ROA_TOTAL_SYS = "75496.0000 SYS"

/**
 * `bytes_per_unit` for `activateroa` — bytes of RAM per smallest SYS unit. Must divide `newaccount_ram`
 * (1144 = 104 × 11), which the contract enforces (`check_divisible_byte_price`).
 */
export const ROA_BYTES_PER_UNIT = 104

export const DEFAULT_RESOURCE_WEIGHT = "25.0000 SYS"
export const DEFAULT_RAM_WEIGHT = "25.0000 SYS"

/**
 * Bootstrap node owner account name.
 *
 * Registered during post-bootstrap operations setup via the real `sysio.roa::nodeownreg` flow (the
 * same path the NFT-claim depot drives -- NOT the `forcereg` admin shortcut) at tier 1 (Validator).
 * It then issues the operator/underwriter ROA resource policies. The name is kept to 2-6 characters
 * so it satisfies `sysio.roa::valid_name_for_tier` for tier 1; a longer name (e.g. a 12-char producer
 * name) would be rejected with NAME_INVALID on the real registration path.
 *
 * Single source of truth: ClusterManager registers it, OperatorProvisioning issues from it, and any
 * flow that issues its own ROA policy imports this constant rather than hardcoding the account name.
 */
export const BOOTSTRAP_NODE_OWNER = "wireno"

/**
 * Name of the kiod wallet the bootstrap creates and every post-bootstrap
 * helper / flow re-opens to sign actions. Changing it orphans the wallet
 * file + password persisted under `<clusterPath>/wallet` by earlier runs.
 */
export const DEFAULT_WALLET_NAME = "default"

// ---------------------------------------------------------------------------
// Port bases
// ---------------------------------------------------------------------------

/** Base P2P port for producer/API nodes. */
export const BASE_P2P_PORT = 9876

/** Base HTTP port for producer/API nodes. */
export const BASE_HTTP_PORT = 8888

/** Bios node P2P port (base - 100). */
export const BIOS_P2P_PORT = BASE_P2P_PORT - 100 // 9776

/** Bios node HTTP port (base - 100). */
export const BIOS_HTTP_PORT = BASE_HTTP_PORT - 100 // 8788

// ---------------------------------------------------------------------------
// Timeouts (seconds unless noted)
// ---------------------------------------------------------------------------

/** Producer handoff timeout in seconds. */
export const PRODUCER_HANDOFF_TIMEOUT_S = 90

// ---------------------------------------------------------------------------
// Chain limits (used in genesis and nodeop args)
// ---------------------------------------------------------------------------

/** Maximum block CPU usage (microseconds). */
export const MAX_BLOCK_CPU_USAGE = 400000

/** Maximum transaction CPU usage (microseconds). */
export const MAX_TRANSACTION_CPU_USAGE = 375000

/** Maximum number of active block producers. */
export const MAX_PRODUCERS = 21

// ---------------------------------------------------------------------------
// nodeop extra arguments (passed via --nodeop in cluster_manager.py)
// ---------------------------------------------------------------------------

export const NODEOP_EXTRA_ARGS = {
  voteThreads: 4,
  maxTransactionTime: -1,
  abiSerializerMaxTimeMs: 990_000,
  maxClients: 25,
  connectionCleanupPeriod: 15,
  httpMaxResponseTimeMs: 990_000
} as const

// ---------------------------------------------------------------------------
// Default plugins loaded for every node
// ---------------------------------------------------------------------------

export const BASE_PLUGINS = [
  "sysio::net_plugin",
  "sysio::chain_api_plugin"
] as const

export const PRODUCER_PLUGINS = [
  "sysio::producer_plugin",
  "sysio::producer_api_plugin",
  "sysio::trace_api_plugin"
] as const

// ---------------------------------------------------------------------------
// Contract relative paths (relative to buildDir)
// ---------------------------------------------------------------------------

export const CONTRACT_PATHS = {
  /** contracts/sysio.bios */
  "sysio.bios": "contracts/sysio.bios",
  /** contracts/sysio.roa */
  "sysio.roa": "contracts/sysio.roa",
  /** contracts/sysio.system */
  "sysio.system": "contracts/sysio.system",
  /** contracts/sysio.token */
  "sysio.token": "contracts/sysio.token",
  /** contracts/sysio.msig */
  "sysio.msig": "contracts/sysio.msig",
  /** contracts/sysio.wrap */
  "sysio.wrap": "contracts/sysio.wrap",
  /** unittests/test-contracts (noop, optional) */
  noop: "unittests/test-contracts"
} as const

export type ContractName = keyof typeof CONTRACT_PATHS

// ---------------------------------------------------------------------------
// OPP contract paths (relative to wire-sysio SOURCE dir, pre-built)
// ---------------------------------------------------------------------------

export const OPP_CONTRACT_PATHS = {
  "sysio.chains": "contracts/sysio.chains",
  "sysio.tokens": "contracts/sysio.tokens",
  "sysio.epoch": "contracts/sysio.epoch",
  "sysio.opreg": "contracts/sysio.opreg",
  "sysio.msgch": "contracts/sysio.msgch",
  "sysio.uwrit": "contracts/sysio.uwrit",
  "sysio.reserv": "contracts/sysio.reserv",
  "sysio.chalg": "contracts/sysio.chalg",
  // sysio.dclaim is a depot-side contract (not a true OPP attestation
  // handler), but it deploys/configures via the same path: setContract +
  // setPriv + sysio.code grant on its own active permission so it can
  // inline-transfer WIRE on `claim`. Co-locating with OPP contracts keeps
  // the deploy list a single source of truth.
  "sysio.dclaim": "contracts/sysio.dclaim"
} as const

export type OppContractName = keyof typeof OPP_CONTRACT_PATHS

// ---------------------------------------------------------------------------
// OPP system accounts
// ---------------------------------------------------------------------------

export const OPP_SYSTEM_ACCOUNTS = [
  "sysio.chains",
  "sysio.tokens",
  "sysio.epoch",
  "sysio.opreg",
  "sysio.msgch",
  "sysio.uwrit",
  "sysio.reserv",
  "sysio.chalg",
  // Mirrors OPP_CONTRACT_PATHS; dclaim needs sysio.code on its active perm
  // so `claim` and `linkswept` can inline-send WIRE transfers.
  "sysio.dclaim"
] as const

// ---------------------------------------------------------------------------
// Batch operator & underwriter plugins
// ---------------------------------------------------------------------------

export const BATCH_OPERATOR_PLUGINS = [
  "sysio::batch_operator_plugin",
  "sysio::external_debugging_plugin",
  "sysio::outpost_ethereum_client_plugin",
  "sysio::outpost_solana_client_plugin",
  "sysio::cron_plugin"
] as const

export const UNDERWRITER_PLUGINS = [
  "sysio::underwriter_plugin",
  "sysio::outpost_ethereum_client_plugin",
  "sysio::outpost_solana_client_plugin"
] as const

// ---------------------------------------------------------------------------
// Account name generators for batch operators and underwriters
// ---------------------------------------------------------------------------

/**
 * The 26 lowercase ASCII letters, used as single-character suffixes for
 * operator account names. Indexing wraps via modulo, so clusters with more
 * than 26 operators will reuse letters — raise this only if you're also
 * changing the on-chain account naming scheme.
 */
const LowercaseAlphabet = "abcdefghijklmnopqrstuvwxyz"

/**
 * Generate a batch operator account name from its index.
 *
 * @param index - Zero-based operator index within the cluster.
 * @returns Account name of the form `batchop.<letter>`.
 * @example batchOperatorAccountName(0) // "batchop.a"
 */
export function batchOperatorAccountName(index: number): string {
  return `batchop.${LowercaseAlphabet[index % LowercaseAlphabet.length]}`
}

/**
 * Generate an underwriter account name from its index.
 *
 * @param index - Zero-based underwriter index within the cluster.
 * @returns Account name of the form `uwrit.<letter>`.
 * @example underwriterAccountName(1) // "uwrit.b"
 */
export function underwriterAccountName(index: number): string {
  return `uwrit.${LowercaseAlphabet[index % LowercaseAlphabet.length]}`
}

// ---------------------------------------------------------------------------
// Emissions config (sysio.system::setemitcfg)
// ---------------------------------------------------------------------------

/**
 * Shape of the `sysio.system::setemitcfg` action payload.
 *
 * Mirrors the on-chain `emission_config` struct in
 * `wire-sysio/contracts/sysio.system/include/sysio.system/emissions.hpp`
 * (post wire-sysio PR #354 — no `capital_bps`; the implicit capital reserve
 * is `10000 - compute - capex - governance`, drained lazily by
 * `sysio.system::fundclaim` on each `sysio.dclaim::onreward`).
 *
 * Until @wireio/sdk-core regenerates types against the new ABI, callers
 * push this payload via `clio.pushAction<EmissionConfig>(...)`.
 */
export interface EmissionConfig {
  // Node-owner tier allocations (WIRE subunits, 9 decimals)
  t1_allocation: number
  t2_allocation: number
  t3_allocation: number
  // Vesting durations per tier (seconds)
  t1_duration: number
  t2_duration: number
  t3_duration: number
  // Minimum claim threshold (subunits)
  min_claimable: number
  // T5 treasury
  t5_distributable: number
  t5_floor: number
  // Decay + emission caps expressed annually; payepoch derives per-epoch
  // values from sysio.epoch::epochcfg::epoch_duration_sec.
  target_annual_decay_bps: number
  annual_initial_emission: number
  annual_max_emission: number
  annual_min_emission: number
  // Category splits (bps). compute + capex + governance <= 10000.
  // Implicit capital reserve = 10000 - sum.
  compute_bps: number
  capex_bps: number
  governance_bps: number
  // compute_bps sub-split between producers and batch operators (must sum to 10000)
  producer_bps: number
  batch_op_bps: number
  // Producer / standby ranking
  standby_end_rank: number
  // Epoch-log retention envelope
  epoch_log_retention_count: number
  // payepoch firing cadence (in epochs). 1 = fire every epoch.
  pay_cadence_epochs: number
}

/**
 * Default emissions config used by ClusterManager bootstrap.
 *
 * Numbers mirror `wire-sysio/contracts/tests/emissions_tests.cpp` realistic
 * fixture (`setemitcfg_with_cadence`):
 * - 9-decimal WIRE subunits everywhere
 * - 30.6% annual decay survival (decay_bps = 6940)
 * - compute 40% / capex 20% / governance 10% → implicit capital reserve 30%
 * - compute split: producer 70% / batch op 30%
 *
 * `pay_cadence_epochs` defaults to 1 so soak runs see a payepoch every epoch
 * (matches single-epoch test fixture). Real chains use higher cadence;
 * flows can override via `ClusterConfig.emissionConfig`.
 */
export const EMISSION_CONFIG_DEFAULTS: EmissionConfig = {
  // Node-owner tiers — mirror test fixture (T1 = 7.5M WIRE total tier
  // allocation; T2/T3 scaled by tier-size ratio).
  t1_allocation: 7_500_000_000_000_000, // 7,500,000 WIRE × 1e9
  t2_allocation: 15_000_000_000_000_000, // 15,000,000 WIRE × 1e9
  t3_allocation: 30_000_000_000_000_000, // 30,000,000 WIRE × 1e9
  // SECONDS_PER_MONTH baseline = 30 days
  t1_duration: 12 * 30 * 24 * 60 * 60,
  t2_duration: 24 * 30 * 24 * 60 * 60,
  t3_duration: 36 * 30 * 24 * 60 * 60,
  min_claimable: 10_000_000_000, // 10 WIRE
  // T5 treasury: 375M distributable, 125M floor
  t5_distributable: 375_000_000_000_000_000,
  t5_floor: 125_000_000_000_000_000,
  // Decay/emission curve
  target_annual_decay_bps: 6940,
  annual_initial_emission: 563_150_000_000_000 * 365,
  annual_max_emission: 3_000_000_000_000_000 * 365,
  annual_min_emission: 100_000_000_000_000 * 365,
  // Category splits — sum = 7000, implicit capital reserve = 3000
  compute_bps: 4000,
  capex_bps: 2000,
  governance_bps: 1000,
  // compute split
  producer_bps: 7000,
  batch_op_bps: 3000,
  // Producer ranking
  standby_end_rank: 28,
  epoch_log_retention_count: 8640,
  // Soak-friendly: emit every epoch
  pay_cadence_epochs: 1
}
