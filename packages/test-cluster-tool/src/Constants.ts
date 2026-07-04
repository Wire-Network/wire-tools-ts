import { Option } from "@3fv/prelude-ts"
import { Hash, KeyType, PrivateKey } from "@wireio/sdk-core"

/**
 * Cross-cutting harness constants — development keys, system-account names,
 * token / ROA parameters, contract paths, plugin sets, account-name generators,
 * and the emissions config defaults. Ported from the former
 * the former `cluster/constants.ts`; network ports are NOT here — they live on
 * `config/BindConfig.ts`, which owns binding.
 */
export namespace Constants {
  /** Seed for the deterministic dev K1 key pair (matches the genesis bios key). */
  const DefaultK1KeyPairSeed = "nathan"

  /** The deterministic development K1 key pair (genesis bios key). */
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

  /** Seed for the deterministic dev BLS key pair. */
  const DefaultBLSKeyPairSeed = "wire"

  /** The deterministic development BLS key pair (genesis finalizer key). */
  export const DefaultBLSKeyPair = Option.try(() => {
    const privKeyDigest = Hash.sha256().update(DefaultBLSKeyPairSeed).digest(),
      privateKey = PrivateKey.regenerate(KeyType.BLS, privKeyDigest),
      publicKey = privateKey.toPublic()
    return {
      privateKey,
      publicKey,
      proofOfPossession: privateKey.proofOfPossessionSignature,
      privateKeyStr: privateKey.toString(),
      publicKeyStr: publicKey.toString(),
      proofOfPossessionStr: privateKey.proofOfPossessionString
    }
  }).getOrThrow(`Failed to create default BLS key pair: ${DefaultBLSKeyPairSeed}`)

  export type DefaultBLSKeyPairType = typeof DefaultBLSKeyPair

  /** Default sysio development BLS private key. */
  export const DEV_BLS_PRIVATE_KEY = DefaultBLSKeyPair.privateKeyStr
  /** Default sysio development BLS public key. */
  export const DEV_BLS_PUBLIC_KEY = DefaultBLSKeyPair.publicKeyStr
  /** Default sysio development BLS proof of possession. */
  export const DEV_BLS_PROOF_OF_POSSESSION = DefaultBLSKeyPair.proofOfPossessionStr

  /**
   * Format a nodeop signature-provider config value:
   * `<name>,<chain-kind>,<key-type>,<public-key>,KEY:<private-key>`.
   *
   * @param name - Provider name.
   * @param chainKind - Chain-kind string (`wire` / `ethereum` / `solana`).
   * @param keyType - Key-type string (`wire` / `wire_bls` / `ethereum` / `solana`).
   * @param publicKey - Public key string.
   * @param privateKey - Private key string.
   * @returns The formatted signature-provider spec.
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

  /** The default dev WIRE signature-provider spec. */
  export function devSignatureProvider(): string {
    return formatSignatureProvider(
      `wire-${DEV_K1_PUBLIC_KEY}`,
      "wire",
      "wire",
      DEV_K1_PUBLIC_KEY,
      DEV_K1_PRIVATE_KEY
    )
  }

  /** System accounts created during bootstrap. */
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
    "sysio.dclaim",
    "sysio.gov",
    "sysio.ops",
    "dev.owner1"
  ] as const

  export type SystemAccountName = (typeof SYSTEM_ACCOUNTS)[number]

  /** Maximum token supply: 1 billion. */
  export const TOKEN_MAX_SUPPLY = "1000000000.0000 SYS"
  /** Initial funds transferred to each producer account. */
  export const PRODUCER_INITIAL_FUNDS = "1000000.0000 SYS"
  /** Core symbol precision and name (e.g. "4,SYS"). */
  export const CORE_SYMBOL_SPECIFICATION = "4,SYS"
  /** Core symbol name only. */
  export const CORE_SYMBOL = "SYS"
  /** Core symbol decimal precision. */
  export const CORE_SYMBOL_PRECISION = 4

  /**
   * `total_sys` for `sysio.roa::activateroa` — the supply the ROA RAM pool is
   * sized from. Changing it resizes the RAM pool; see `docs/production-bootstrap.md`.
   */
  export const ROA_TOTAL_SYS = "75496.0000 SYS"
  /** `bytes_per_unit` for `activateroa`; must divide `newaccount_ram` (1144). */
  export const ROA_BYTES_PER_UNIT = 104
  export const DEFAULT_RESOURCE_WEIGHT = "25.0000 SYS"
  export const DEFAULT_RAM_WEIGHT = "25.0000 SYS"

  /** Bootstrap node-owner account (2-6 chars to satisfy tier-1 name rules). */
  export const BOOTSTRAP_NODE_OWNER = "wireno"

  /** Name of the kiod wallet the bootstrap creates and helpers re-open. */
  export const DEFAULT_WALLET_NAME = "default"

  /** Producer-handoff timeout (seconds). */
  export const PRODUCER_HANDOFF_TIMEOUT_S = 90
  /** Maximum block CPU usage (microseconds). */
  export const MAX_BLOCK_CPU_USAGE = 400_000
  /** Maximum transaction CPU usage (microseconds). */
  export const MAX_TRANSACTION_CPU_USAGE = 375_000
  /** Maximum number of active block producers. */
  export const MAX_PRODUCERS = 21

  /** Extra nodeop arguments applied to every node. */
  export const NODEOP_EXTRA_ARGS = {
    voteThreads: 4,
    maxTransactionTime: -1,
    abiSerializerMaxTimeMs: 990_000,
    maxClients: 25,
    connectionCleanupPeriod: 15,
    httpMaxResponseTimeMs: 990_000
  } as const

  /** Plugins loaded for every node. */
  export const BASE_PLUGINS = [
    "sysio::net_plugin",
    "sysio::chain_api_plugin"
  ] as const

  /** Additional plugins for producer / bios nodes. */
  export const PRODUCER_PLUGINS = [
    "sysio::producer_plugin",
    "sysio::producer_api_plugin",
    "sysio::trace_api_plugin"
  ] as const

  /** Core system contract paths (relative to the build dir). */
  export const CONTRACT_PATHS = {
    "sysio.bios": "contracts/sysio.bios",
    "sysio.roa": "contracts/sysio.roa",
    "sysio.system": "contracts/sysio.system",
    "sysio.token": "contracts/sysio.token",
    "sysio.msig": "contracts/sysio.msig",
    "sysio.wrap": "contracts/sysio.wrap",
    noop: "unittests/test-contracts"
  } as const

  export type ContractName = keyof typeof CONTRACT_PATHS

  /** OPP contract paths (relative to the wire-sysio source dir, pre-built). */
  export const OPP_CONTRACT_PATHS = {
    "sysio.chains": "contracts/sysio.chains",
    "sysio.tokens": "contracts/sysio.tokens",
    "sysio.epoch": "contracts/sysio.epoch",
    "sysio.opreg": "contracts/sysio.opreg",
    "sysio.msgch": "contracts/sysio.msgch",
    "sysio.uwrit": "contracts/sysio.uwrit",
    "sysio.reserv": "contracts/sysio.reserv",
    "sysio.chalg": "contracts/sysio.chalg",
    "sysio.dclaim": "contracts/sysio.dclaim"
  } as const

  export type OppContractName = keyof typeof OPP_CONTRACT_PATHS

  /** OPP system accounts (need `sysio.code` on their active permission). */
  export const OPP_SYSTEM_ACCOUNTS = [
    "sysio.chains",
    "sysio.tokens",
    "sysio.epoch",
    "sysio.opreg",
    "sysio.msgch",
    "sysio.uwrit",
    "sysio.reserv",
    "sysio.chalg",
    "sysio.dclaim"
  ] as const

  /** Plugins loaded on a batch-operator node. */
  export const BATCH_OPERATOR_PLUGINS = [
    "sysio::batch_operator_plugin",
    "sysio::external_debugging_plugin",
    "sysio::outpost_ethereum_client_plugin",
    "sysio::outpost_solana_client_plugin",
    "sysio::cron_plugin"
  ] as const

  /** Plugins loaded on an underwriter node. */
  export const UNDERWRITER_PLUGINS = [
    "sysio::underwriter_plugin",
    "sysio::outpost_ethereum_client_plugin",
    "sysio::outpost_solana_client_plugin"
  ] as const

  /** Lowercase ASCII alphabet — single-character operator-name suffixes (wraps via modulo). */
  const LowercaseAlphabet = "abcdefghijklmnopqrstuvwxyz"

  /**
   * Batch-operator account name for an index — `batchop.<letter>`.
   *
   * @param index - Zero-based operator index.
   * @returns The account name (e.g. `batchOperatorAccountName(0)` → `"batchop.a"`).
   */
  export function batchOperatorAccountName(index: number): string {
    return `batchop.${LowercaseAlphabet[index % LowercaseAlphabet.length]}`
  }

  /**
   * Underwriter account name for an index — `uwrit.<letter>`.
   *
   * @param index - Zero-based underwriter index.
   * @returns The account name (e.g. `underwriterAccountName(1)` → `"uwrit.b"`).
   */
  export function underwriterAccountName(index: number): string {
    return `uwrit.${LowercaseAlphabet[index % LowercaseAlphabet.length]}`
  }

  /**
   * Shape of the `sysio.system::setemitcfg` action payload. Mirrors the
   * on-chain `emission_config` struct (post wire-sysio PR #354 — no
   * `capital_bps`; the implicit capital reserve is the remainder).
   */
  export interface EmissionConfig {
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

  /** Default emissions config used by bootstrap (mirrors the realistic test fixture). */
  export const EMISSION_CONFIG_DEFAULTS: EmissionConfig = {
    t1_allocation: 7_500_000_000_000_000,
    t2_allocation: 15_000_000_000_000_000,
    t3_allocation: 30_000_000_000_000_000,
    t1_duration: 12 * 30 * 24 * 60 * 60,
    t2_duration: 24 * 30 * 24 * 60 * 60,
    t3_duration: 36 * 30 * 24 * 60 * 60,
    min_claimable: 10_000_000_000,
    t5_distributable: 375_000_000_000_000_000,
    t5_floor: 125_000_000_000_000_000,
    target_annual_decay_bps: 6940,
    annual_initial_emission: 563_150_000_000_000 * 365,
    annual_max_emission: 3_000_000_000_000_000 * 365,
    annual_min_emission: 100_000_000_000_000 * 365,
    compute_bps: 4000,
    capex_bps: 2000,
    governance_bps: 1000,
    producer_bps: 7000,
    batch_op_bps: 3000,
    standby_end_rank: 28,
    epoch_log_retention_count: 8640,
    pay_cadence_epochs: 1
  }
}

/**
 * Protocol timing envelope (author guidance, 2026-07-04) — the authoritative
 * worst-case durations of OPP propagation classes at the 60s minimum epoch.
 * An epoch can extend ~15–30s past its nominal duration while a scheduled
 * batch operator has yet to deliver (operators crank on ~15s internal loops);
 * collateral deposit + depot verification takes ~4–6 minutes; a single-hop
 * wait (act on an outpost, verify on the depot — or the reverse) commonly
 * reaches 5–7 minutes; a full outpost → depot → outpost path doubles that to
 * 10–14 minutes. Every flow's protocol-wait budget derives from this namespace
 * and pins the TOP of its class: polls return the moment the condition holds,
 * so a generous ceiling adds no wall clock to a healthy run, while an
 * undershot one fails healthy runs at the envelope's tail. There is NO
 * concurrency-derived scaling — concurrency reduces total wall clock, it does
 * not define protocol latency.
 */
export namespace ProtocolTiming {
  /** Max extension an epoch can run past `epoch_duration_sec` while a
   *  scheduled batch operator has yet to deliver (s). */
  export const EpochExtensionMaxSec = 30

  /** Collateral deposit + depot verification (ms) — 6-minute envelope top. */
  export const CollateralVerifyBudgetMs = 360_000

  /** Single hop — act on an outpost, verify on the depot, or the reverse
   *  (ms) — 7-minute envelope top. */
  export const SingleHopBudgetMs = 420_000

  /** Double hop — outpost → depot → outpost (ms) — 14-minute envelope top. */
  export const DoubleHopBudgetMs = 840_000

  /**
   * Effective per-epoch duration for N-epoch deadlines (s): the nominal
   * duration plus the maximum delivery extension, so an N-epoch budget
   * survives N consecutively-extended epochs.
   *
   * @param epochDurationSec - The cluster's configured epoch duration (s).
   * @returns The extension-inclusive per-epoch duration (s).
   */
  export function effectiveEpochSec(epochDurationSec: number): number {
    return epochDurationSec + EpochExtensionMaxSec
  }
}
