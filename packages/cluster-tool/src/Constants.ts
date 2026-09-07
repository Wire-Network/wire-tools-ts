import { Option } from "@3fv/prelude-ts"
import { Hash, KeyType, PrivateKey } from "@wireio/sdk-core"

/**
 * Cross-cutting harness constants — development keys, system-account names,
 * token / ROA parameters, contract paths, plugin sets, operator-account-handle
 * generators, and the emissions config defaults. Ported from the former
 * the former `cluster/constants.ts`; network ports are NOT here — they live on
 * `config/BindConfigProvider.ts`, which owns binding.
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
  }).getOrThrow(
    `Failed to create default BLS key pair: ${DefaultBLSKeyPairSeed}`
  )

  export type DefaultBLSKeyPairType = typeof DefaultBLSKeyPair

  /** Default sysio development BLS private key. */
  export const DEV_BLS_PRIVATE_KEY = DefaultBLSKeyPair.privateKeyStr
  /** Default sysio development BLS public key. */
  export const DEV_BLS_PUBLIC_KEY = DefaultBLSKeyPair.publicKeyStr
  /** Default sysio development BLS proof of possession. */
  export const DEV_BLS_PROOF_OF_POSSESSION =
    DefaultBLSKeyPair.proofOfPossessionStr

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

  /**
   * Extra nodeop arguments applied to every node, in EVERY phase — the ini is
   * read via `--config-dir` by the bootstrap AND post-bootstrap launch forms
   * alike, so only phase-independent values may live here.
   *
   * The SHARED-25 deadlines (`max-transaction-time`,
   * `abi-serializer-max-time-ms`, `http-max-response-time-ms`) are phase- and
   * role-dependent and live solely in `NodeopProcess`'s companion constants:
   * an ini kv would resurrect a value the post-bootstrap argv deliberately
   * omits, since a CLI flag only wins when it is actually emitted.
   */
  export const NODEOP_EXTRA_ARGS = {
    voteThreads: 4,
    connectionCleanupPeriod: 15
  } as const

  /**
   * THE one spelling of the p2p plugin. It owns `p2p-peer-address` AND
   * `agent-name`, so any node that configures either must LOAD it — appbase
   * registers every compiled-in plugin's options regardless of which are
   * loaded, so the lines are otherwise accepted-and-ignored.
   */
  export const NET_PLUGIN = "sysio::net_plugin"
  /** THE one spelling of the chain HTTP-API plugin (`/v1/chain/*`). */
  export const CHAIN_API_PLUGIN = "sysio::chain_api_plugin"

  /**
   * Plugins loaded for every CLUSTER node.
   *
   * COMPOSED from {@link NET_PLUGIN} + {@link CHAIN_API_PLUGIN} so a standalone
   * artifact can name the two individually instead of spreading this array: a
   * future cluster-wide addition here must NOT silently reach
   * `ApiNodeIniRenderer.Plugins`, which is governed by the API-node baseline.
   */
  export const BASE_PLUGINS = [NET_PLUGIN, CHAIN_API_PLUGIN] as const

  /** Additional plugins for producer / bios nodes. */
  export const PRODUCER_PLUGINS = [
    "sysio::producer_plugin",
    "sysio::producer_api_plugin"
  ] as const

  /**
   * THE one spelling of the trace-api plugin, shared by the ini renderer and
   * the nodeop argv builder.
   *
   * It is NOT in {@link PRODUCER_PLUGINS} because it is the one role-plugin
   * whose presence is GATED (SHARED-25 AC#4, the author's D3 carve-out):
   * `NodeConfig.runsTraceApiPlugin` keeps it on every role of a LOCAL cluster
   * and drops it from the production-shaped external tree's bios / producer
   * nodes. Two spellings would let the gate move in one surface only.
   */
  export const TRACE_API_PLUGIN = "sysio::trace_api_plugin"

  /**
   * THE one spelling of nodeop's chain-state DB size option (SHARED-31), used
   * bare as an ini key / yargs flag name and as `--${…}` in a nodeop argv.
   *
   * Changing it changes the emitted `config.ini` key, the `create-api-node`
   * flag, and the cluster nodeop argv together — which is the point: three
   * spellings would let one surface drift.
   */
  export const CHAIN_STATE_DB_SIZE_MB_OPTION = "chain-state-db-size-mb"

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

  /** Lowercase ASCII alphabet — single-character operator-account suffixes (wraps via modulo). */
  const LowercaseAlphabet = "abcdefghijklmnopqrstuvwxyz"

  /**
   * Batch-operator durable harness LABEL for an index — `batchop.<letter>`.
   * The label is the operator's `ClusterKeyStore` key and its SSM secret-id
   * `{account}` segment. It does NOT exist on chain — the on-chain account name
   * is node-owner-generated (`wireno.<random>`, `OperatorAccount.account`), and
   * its suffix is nonce-derived entropy, so it cannot be requested.
   *
   * @param index - Zero-based operator index.
   * @returns The label (e.g. `batchOperatorLabel(0)` → `"batchop.a"`).
   */
  export function batchOperatorLabel(index: number): string {
    return `batchop.${LowercaseAlphabet[index % LowercaseAlphabet.length]}`
  }

  /**
   * Underwriter durable harness LABEL for an index — `uwrit.<letter>`. Same
   * label-vs-generated-`account` split as {@link batchOperatorLabel}.
   *
   * @param index - Zero-based underwriter index.
   * @returns The label (e.g. `underwriterLabel(1)` → `"uwrit.b"`).
   */
  export function underwriterLabel(index: number): string {
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
    // Node-owner allocations are PER OWNER, not per tier. `addnodeowner` copies the
    // tier's value verbatim into that one owner's `nodedist` row, so a tier's total
    // exposure is this value times the tier cap (21 / 84 / 1000 — the `TN_MAX_NODE_OWNERS`
    // constants in wire-sysio `emissions.hpp`). At these values the three tiers commit
    // 341,500,000 WIRE against the 1,000,000,000 WIRE supply issued at bootstrap.
    t1_allocation: 7_500_000_000_000_000, // 7,500,000 WIRE x 1e9
    t2_allocation: 1_000_000_000_000_000, // 1,000,000 WIRE x 1e9
    t3_allocation: 100_000_000_000_000, // 100,000 WIRE x 1e9
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
 *
 * TOPOLOGY is a different thing and IS a legitimate input: the finalizer-set
 * size genuinely determines how long one Savanna quorum round takes, because
 * every finalizer's vote has to propagate and aggregate. That is the protocol's
 * own latency, not a measure of parallel work — see
 * {@link ProtocolTiming.irreversibilityBudgetMs}, the only budget here that
 * takes a parameter.
 */
export namespace ProtocolTiming {
  /** Max extension an epoch can run past `epoch_duration_sec` while a
   *  scheduled batch operator has yet to deliver (s). */
  export const EpochExtensionMaxSec = 30

  /**
   * Irreversibility floor (ms) — the budget on a single-finalizer cluster.
   *
   * Sized so dev/flow topologies keep essentially the previous flat 60s
   * behaviour: every `flow-*` bootstrap runs a handful of finalizers, so this
   * floor plus a few increments lands within seconds of the old value.
   */
  export const IrreversibilityBaseMs = 60_000

  /**
   * Per-finalizer increment on the irreversibility budget (ms).
   *
   * TOPOLOGY-derived, not concurrency-derived — the distinction is why this is
   * permitted where the namespace note bans scaling. Savanna finalizes on a
   * quorum certificate: every finalizer's vote must propagate and aggregate, so
   * one finalization round's wall clock genuinely grows with the SIZE OF THE
   * FINALIZER SET. That is a property of the protocol, not of how much work the
   * harness runs in parallel.
   *
   * Calibrated against a measured step: on 2026-08-04 a 21-finalizer cluster
   * took **49.4 s** to reach irreversibility on `create-roa` — the step right
   * before `create-acct` blew the flat 60 s budget and killed the run. 21
   * finalizers here yields 186 s, ~3.7x the observed latency, the margin an
   * envelope-top budget wants. Polls return the moment LIB passes the block, so
   * the ceiling costs a healthy run nothing.
   */
  export const IrreversibilityPerFinalizerMs = 6_000

  /**
   * The irreversibility budget for a cluster with `finalizerCount` finalizers.
   *
   * @param finalizerCount - Finalizers in the genesis policy (the producer
   *   nodes — `ConsensusSteps` builds the policy from exactly that set).
   * @returns Wall-clock budget for one transaction to reach LIB (ms).
   */
  export function irreversibilityBudgetMs(finalizerCount: number): number {
    return (
      IrreversibilityBaseMs +
      Math.max(finalizerCount, 1) * IrreversibilityPerFinalizerMs
    )
  }

  /** Collateral deposit + depot verification (ms) — 6-minute envelope top. */
  export const CollateralVerifyBudgetMs = 360_000

  /** Single hop — act on an outpost, verify on the depot, or the reverse
   *  (ms) — 7-minute envelope top. */
  export const SingleHopBudgetMs = 420_000

  /** Double hop — outpost → depot → outpost (ms) — 14-minute envelope top. */
  export const DoubleHopBudgetMs = 840_000

  /**
   * Ceiling margin a verify step carries ABOVE its inner poll deadline (ms),
   * so the step's own timeout never races the poll it wraps (finality waits +
   * the final post-poll reads fit inside the margin). Shared by every flow
   * that pairs a `pollUntil` deadline with an enclosing step timeout.
   */
  export const PollDeadlineBufferMs = 30_000

  /**
   * Epoch-advance liveness budget as a count of effective-epoch windows. At the
   * default 60s epoch this is 3 × (60 + 30)s = 270s — ≥ the ~4min a *resumed*
   * cluster can need to restart OPP circulation before `current_epoch_index`
   * advances. A healthy cluster still passes in ~1 epoch (the poll returns the
   * moment the index moves), so the larger ceiling adds no wall clock to a
   * healthy run — it only keeps a slow restart from failing a live cluster.
   *
   * ONE envelope, two owners: `ClusterManager.run`'s post-relaunch liveness
   * check and `ClusterBuildDefaults`' bootstrap epoch-advance gate.
   */
  export const EpochVerifyEpochCount = 3

  /** Poll gap for the epoch-advance liveness verify (ms). */
  export const EpochVerifyPollIntervalMs = 1_000

  /** Seconds → milliseconds, the conversion every epoch-derived budget applies. */
  export const MsPerSecond = 1_000

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
