/**
 * Hardcoded constants extracted from cluster_manager.py and launcher.py.
 *
 * These values mirror the Python originals so the TypeScript harness produces
 * identical cluster configurations.
 */

import { Option } from "@3fv/prelude-ts"
import { Hash, KeyType, PrivateKey } from "@wireio/sdk-core"

// ---------------------------------------------------------------------------
// Development key pair (matches genesis bios key)
// ---------------------------------------------------------------------------
const DefaultKeyPairSeed = "nathan"

export const DefaultKeyPair = Option.try(() => {
  const privKeyDigest = Hash.sha256().update(DefaultKeyPairSeed).digest(),
    privateKey = PrivateKey.regenerate(KeyType.K1, privKeyDigest),
    publicKey = privateKey.toPublic()

  return {
    privateKey,
    publicKey,
    privateKeyWIF: privateKey.toWif(),
    publicKeyWIF: publicKey.toLegacyString()
  }
}).getOrThrow(`Failed to create default key pair: ${DefaultKeyPairSeed}`)

export type DefinedKeyPair = typeof DefaultKeyPair

/** Default sysio development private key (WIF format). */
export const DEV_PRIVATE_KEY = DefaultKeyPair.privateKeyWIF

/** Default sysio development public key (SYS prefix). */
export const DEV_PUBLIC_KEY = DefaultKeyPair.publicKeyWIF

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
    `wire-${DEV_PUBLIC_KEY}`,
    "wire",
    "wire",
    DEV_PUBLIC_KEY,
    DEV_PRIVATE_KEY
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
  "sysio.epoch",
  "sysio.msgch",
  "sysio.uwrit",
  "sysio.chalg",
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

/** Total SYS allocated for ROA activation. */
export const ROA_TOTAL_SYS = "75496.0000 SYS"

/** Bytes per resource unit for ROA. */
export const ROA_BYTES_PER_UNIT = 104

// ---------------------------------------------------------------------------
// Port bases
// ---------------------------------------------------------------------------

/** Base P2P port for producer/API nodes. */
export const BASE_P2P_PORT = 9876

/** @deprecated Use BASE_P2P_PORT instead. */
export const P2P_PORT_BASE = BASE_P2P_PORT

/** Base HTTP port for producer/API nodes. */
export const BASE_HTTP_PORT = 8888

/** @deprecated Use BASE_HTTP_PORT instead. */
export const HTTP_PORT_BASE = BASE_HTTP_PORT

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
  abiSerializerMaxTimeMs: 990000,
  maxClients: 25,
  connectionCleanupPeriod: 15,
  httpMaxResponseTimeMs: 990000
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
  /** libraries/testing/contracts/sysio.bios */
  "sysio.bios": "libraries/testing/contracts/sysio.bios",
  /** libraries/testing/contracts/sysio.roa */
  "sysio.roa": "libraries/testing/contracts/sysio.roa",
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
  "sysio.epoch": "contracts/sysio.epoch",
  "sysio.msgch": "contracts/sysio.msgch",
  "sysio.uwrit": "contracts/sysio.uwrit",
  "sysio.chalg": "contracts/sysio.chalg"
} as const

export type OppContractName = keyof typeof OPP_CONTRACT_PATHS

// ---------------------------------------------------------------------------
// OPP system accounts
// ---------------------------------------------------------------------------

export const OPP_SYSTEM_ACCOUNTS = [
  "sysio.epoch",
  "sysio.msgch",
  "sysio.uwrit",
  "sysio.chalg"
] as const

// ---------------------------------------------------------------------------
// Batch operator & underwriter plugins
// ---------------------------------------------------------------------------

export const BATCH_OPERATOR_PLUGINS = [
  "sysio::batch_operator_plugin",
  "sysio::outpost_eth_plugin",
  "sysio::outpost_sol_plugin"
] as const

export const UNDERWRITER_PLUGINS = [
  "sysio::underwriter_plugin",
  "sysio::outpost_eth_plugin",
  "sysio::outpost_sol_plugin"
] as const

// ---------------------------------------------------------------------------
// Account name generators for batch operators and underwriters
// ---------------------------------------------------------------------------

const ASCII_LOWER_CONST = "abcdefghijklmnopqrstuvwxyz"

/**
 * Generate a batch operator account name from its index.
 * e.g., index 0 -> "batchop.a", index 1 -> "batchop.b"
 */
export function batchOperatorAccountName(index: number): string {
  return `batchop.${ASCII_LOWER_CONST[index % ASCII_LOWER_CONST.length]}`
}

/**
 * Generate an underwriter account name from its index.
 * e.g., index 0 -> "uwrit.a", index 1 -> "uwrit.b"
 */
export function underwriterAccountName(index: number): string {
  return `uwrit.${ASCII_LOWER_CONST[index % ASCII_LOWER_CONST.length]}`
}
