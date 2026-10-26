import Assert from "node:assert"
import { createHash } from "node:crypto"
import Fs from "node:fs"
import { asOption, Either } from "@3fv/prelude-ts"
import { PublicKey as SolanaPublicKey } from "@solana/web3.js"
import {
  EthereumGenesisSnapshotSchemaCodec,
  SolanaGenesisSnapshotSchemaCodec,
  type ExternalOutpostConfig,
  type LcoImportChainConfig,
  type LcoImportConfig,
  type SchemaCodec,
  type SolanaGenesisSnapshot
} from "@wireio/cluster-tool-shared"
import {
  BootstrapPlatformConfig,
  ChainKind,
  LiqPoolSpec,
  SyndicationSpec
} from "@wireio/opp-typescript-models"
import {
  getCompressedPublicKey,
  KeyType,
  PublicKey,
  SysioContracts
} from "@wireio/sdk-core"
import { getValue, NestedError } from "@wireio/shared"
import { ethers } from "ethers"
import { countBy, sortBy } from "lodash"
import { match } from "ts-pattern"
import { Constants } from "../../Constants.js"
import { isqrt } from "../../utils/bigintUtils.js"
import { abiEnumValue } from "../../utils/enumUtils.js"
import { matchesProtoEnum } from "../../utils/predicateUtils.js"
import type { ImportSeedChainKind } from "./WireDclaimSeedTool.js"

const { SysioContractAccount, SysioContractName, SysioDclaimChainkind } =
  SysioContracts

/**
 * Derives the launch-data (LCO) import from each outpost's frozen pre-launch export: the
 * syndicated positions `sysio.synd::importsynd` replays, the WIRE claims
 * `sysio.dclaim::importseed` credits, and the LCO yield pool `sysio.liq::regliqpool` seeds —
 * the `LiqPoolSpec` / `SyndicationSpec` shapes of the launch `BootstrapPlatformConfig`
 * (wire-sysio `docs/platform-bootstrap-config.md`), checked against its invariants. Values
 * only: `LcoImportSteps` performs the writes.
 *
 * Every economic value an export does not carry — a launch price, the highest tranche
 * price, the pool tuning, the Ethereum booked custody, the claim funding account — comes
 * from the import options, else a named placeholder the plan lists in `placeholders`.
 * Each WIRE claim converts one pretoken to one WIRE.
 */
export namespace WireLcoImportTool {
  /**
   * Credits per `sysio.synd::importsynd` push. Each credit mints or parks inline, so a
   * batch stays small enough for one transaction's CPU budget.
   */
  export const SyndicationBatchSize = 50
  /**
   * Credits per `sysio.dclaim::importseed` push — about 55 KB of action JSON, inside the
   * 128 KB argument the client pushes it through.
   */
  export const ClaimBatchSize = 500
  /** Decimals of liqETH and of Ethereum pretokens (wei scale). */
  export const EthereumDecimals = 18
  /** The largest amount a depot asset holds: `asset::max_amount`, 2^62 − 1. */
  export const AssetMaxAmount = (1n << 62n) - 1n
  /** The largest swap fee of a pool, in 1/10000 of the traded amount. */
  export const MaxPoolFee = 9_999
  /** The largest clip cap of a pool, in basis points of its shadow side. */
  export const MaxDepthCapBps = 10_000
  /**
   * `sysio.swap::inittoken`'s `INIT_MAX`: each pool seed must be below it, in base units
   * (1,000,000 tokens at 9 decimals).
   */
  export const PoolSeedLimit = 10n ** 15n
  /** A pool's pair (LP) token code: one to seven capitals. */
  export const PairCodePattern = /^[A-Z]{1,7}$/
  /** The launch schema version a record carries (`BootstrapPlatformConfig.schema_version`). */
  export const RecordSchemaVersion = 1
  /** Indent of the record's JSON. */
  export const RecordIndent = 2
  /** Prefix of an EVM hex value in display form. */
  export const EvmHexPrefix = "0x"
  /** An EVM hex value's prefix, in either case. */
  export const EvmHexPrefixPattern = /^0x/i
  /**
   * The key type an importable chain's pubkeys carry in `sysio.authex::links`: secp256k1 EM on
   * EVM, ed25519 ED on SVM (`public_key_from_op_address`).
   */
  export const LinkKeyTypes: Record<ImportSeedChainKind, KeyType> = {
    [ChainKind.EVM]: KeyType.EM,
    [ChainKind.SVM]: KeyType.ED
  }

  /** Placeholder launch price of ETH: USD with 8 decimals ($4,000). */
  export const PlaceholderEthereumPriceUsd = "400000000000"
  /** Placeholder launch price of SOL: USD with 8 decimals ($200). */
  export const PlaceholderSolanaPriceUsd = "20000000000"
  /** Placeholder highest tranche price: USD per WIRE with 8 decimals ($0.10). */
  export const PlaceholderHighestTranchePriceUsd = "10000000"
  /**
   * Placeholder pool tuning — the dev bootstrap config's (wire-sysio
   * `etc/config/dex/dex-config.dev.json`): a 0.30 % fee, no locked shares, a one-day
   * conversion horizon, a 0.50 % clip cap and a 1,000-subunit clip floor.
   */
  export const PlaceholderPoolTuning: LiqPoolSpec = LiqPoolSpec.create({
    fee: 30,
    lockedShares: 0n,
    conversionHorizonSec: 86_400,
    depthCapBps: 50,
    clipFloor: 1_000n
  })
  /** Placeholder claim funding account: the system treasury. */
  export const PlaceholderDclaimFundingAccount =
    SysioContractAccount[SysioContractName.system]

  /** A WIRE claim of one native address — the generated `importseed` credit. */
  export type ClaimCredit = SysioContracts.SysioDclaimImportCreditType

  /** A value the import used where no export or option supplied the real one. */
  export interface Placeholder {
    /** Where the real value belongs (`lcoImport.ethereum.nativePriceUsd`). */
    readonly setting: string
    /** The value used. */
    readonly value: string
  }

  /** One outpost chain's import. */
  export interface ChainPlan {
    /** The chain's `importseed` kind. */
    readonly chain: ImportSeedChainKind
    /** The export it was derived from (absolute path). */
    readonly bootstrapJsonFile: string
    /**
     * The outpost program the export was read from: the Solana export's `programId`.
     * Nothing for the Ethereum export, which names no contract.
     */
    readonly programId?: string
    /** Every syndicated position, one per pubkey in display form, sorted by pubkey. */
    readonly syndications: SyndicationSpec[]
    /** Every WIRE claim, one per native address, sorted by address. */
    readonly claims: ClaimCredit[]
    /** The chain's LCO yield pool, its `custodyTotal` the booked custody. */
    readonly pool: LiqPoolSpec
  }

  /** The whole import: each exported chain's plan, the claim funding and every placeholder used. */
  export interface Plan {
    /** The Ethereum outpost's import, or nothing without its export. */
    readonly ethereum: ChainPlan
    /** The Solana outpost's import, or nothing without its export. */
    readonly solana: ChainPlan
    /** The account that funds `sysio.dclaim` with every claim. */
    readonly dclaimFundingAccount: string
    /** Every value the plan took from a placeholder. */
    readonly placeholders: Placeholder[]
  }

  /** One chain's import counts and totals — what a plan's Report row shows of it. */
  export interface ChainSummary {
    /** The export it was derived from. */
    readonly bootstrapJsonFile: string
    /** Syndicated positions. */
    readonly syndicationCount: number
    /** Their total, in the liq token's depot subunits. */
    readonly syndicatedTotal: string
    /** WIRE claims. */
    readonly claimCount: number
    /** Their total, in WIRE subunits. */
    readonly claimTotal: string
    /** The pool's liq side, in the liq token's depot subunits. */
    readonly poolChainAmount: string
    /** The pool's WIRE side, in WIRE subunits. */
    readonly poolWireAmount: string
  }

  /** A plan's counts, totals, placeholders and digest — compact enough for a Step input. */
  export interface Summary {
    /** The Ethereum outpost's import, or nothing. */
    readonly ethereum: ChainSummary
    /** The Solana outpost's import, or nothing. */
    readonly solana: ChainSummary
    /** The claim funding account. */
    readonly dclaimFundingAccount: string
    /** Every value the plan took from a placeholder. */
    readonly placeholders: Placeholder[]
    /** {@link planDigest}: every allocation the plan imports, so no change goes unseen. */
    readonly digest: string
  }

  /** An export as read: its text and the validated document. */
  interface ExportRead<T> {
    readonly text: string
    readonly snapshot: T
  }

  /** One chain's plan plus the placeholders its derivation used. */
  interface ChainDerivation {
    readonly plan: ChainPlan
    readonly placeholders: Placeholder[]
  }

  /** The two USD prices (8 decimals) a pool's WIRE side is computed at. */
  interface PoolPricing {
    readonly nativePriceUsd: bigint
    readonly highestTranchePriceUsd: bigint
  }

  /** A pool's pricing plus the placeholders it used. */
  interface PoolPricingDerivation {
    readonly pricing: PoolPricing
    readonly placeholders: Placeholder[]
  }

  /** A pool plus the placeholders its tuning used. */
  interface PoolDerivation {
    readonly pool: LiqPoolSpec
    readonly placeholders: Placeholder[]
  }

  /** What one chain's pool is derived from. */
  interface PoolSource {
    /** The chain's import configuration. */
    readonly chainConfig: LcoImportChainConfig
    /** The config member naming the chain (`ethereum`) — labels its placeholders. */
    readonly member: string
    /** The depot chain code. */
    readonly chainCode: string
    /** The liq token code. */
    readonly tokenCode: string
    /** The booked custody, in the liq token's depot subunits. */
    readonly custodyTotal: bigint
    /** The chain's syndicated positions. */
    readonly syndications: SyndicationSpec[]
    /** The export's own highest tranche price, when it carries one. */
    readonly exportedTranchePriceUsd: string
    /** The placeholder launch price of the chain's native token. */
    readonly placeholderNativePriceUsd: string
  }

  /** One native address's owed amount, before conversion to WIRE. */
  interface Owed {
    /** The native address, as raw-byte hex. */
    readonly nativeAddress: string
    /** The owed amount in the source's units. */
    readonly amount: bigint
  }

  /**
   * Create the import's plan from its configuration: read and validate each exported
   * chain's export, derive its positions, claims and pool, and collect every placeholder.
   *
   * @param config - The resolved import configuration (`ClusterConfig.lcoImport`).
   * @returns The plan, or nothing when the cluster imports no export.
   * @throws When an export is unreadable or invalid, or a derived value breaks a launch
   *   invariant (a position with no pubkey, no LCO liq left for the pool, a pool parameter
   *   or a total out of range).
   */
  export function createPlan(config: LcoImportConfig): Plan {
    if (config == null) {
      return null
    }
    const ethereum =
        config.ethereum == null ? null : createEthereumPlan(config.ethereum),
      solana = config.solana == null ? null : createSolanaPlan(config.solana),
      fundingPlaceholders: Placeholder[] =
        config.dclaimFundingAccount == null
          ? [
              {
                setting: "lcoImport.dclaimFundingAccount",
                value: PlaceholderDclaimFundingAccount
              }
            ]
          : [],
      plan: Plan = {
        ethereum: ethereum?.plan,
        solana: solana?.plan,
        dclaimFundingAccount:
          config.dclaimFundingAccount ?? PlaceholderDclaimFundingAccount,
        placeholders: [
          ...(ethereum?.placeholders ?? []),
          ...(solana?.placeholders ?? []),
          ...fundingPlaceholders
        ]
      },
      claims = planClaimTotal(plan)
    // One transfer funds every claim, so the total must fit one asset.
    Assert.ok(
      claims <= AssetMaxAmount,
      `WireLcoImportTool: the claims total ${claims} WIRE subunits, beyond the asset range`
    )
    return plan
  }

  /**
   * Refuse an export read from another outpost than the external one the cluster targets:
   * the Solana export's program must be `externalOutposts.solana.programId`.
   *
   * @param plan - The import's plan.
   * @param externalOutposts - The deployed outposts the cluster targets.
   * @throws When the programs differ.
   */
  export function assertExportOutposts(
    plan: Plan,
    externalOutposts: ExternalOutpostConfig
  ): void {
    const exported = plan.solana?.programId,
      targeted = externalOutposts.solana.programId
    Assert.ok(
      exported == null || exported === targeted,
      `WireLcoImportTool: the Solana export was read from program ${exported}, not the outpost ${targeted} the cluster targets`
    )
  }

  /**
   * A SHA-256 digest over every allocation of a plan — each chain's program, positions,
   * claims and pool, and the claim funding account — in plan order.
   *
   * @param plan - The import's plan.
   * @returns The lowercase hex digest.
   */
  export function planDigest(plan: Plan): string {
    const allocations = {
      dclaimFundingAccount: plan.dclaimFundingAccount,
      chains: chainPlans(plan).map(chainPlan => ({
        chain: chainPlan.chain,
        programId: chainPlan.programId,
        syndications: chainPlan.syndications.map(spec =>
          SyndicationSpec.toJson(spec)
        ),
        claims: chainPlan.claims,
        pool: LiqPoolSpec.toJson(chainPlan.pool)
      }))
    }
    return createHash("sha256").update(JSON.stringify(allocations)).digest("hex")
  }

  /**
   * Every chain plan of `plan`, Ethereum first.
   *
   * @param plan - The import's plan.
   * @returns The present chain plans.
   */
  export function chainPlans(plan: Plan): ChainPlan[] {
    return [plan.ethereum, plan.solana].filter(chainPlan => chainPlan != null)
  }

  /**
   * Refuse a plan holding any placeholder: external outposts hold real custody, so every
   * value their import seeds must be the real one.
   *
   * @param plan - The import's plan.
   * @throws Naming every setting still on a placeholder.
   */
  export function assertRealData(plan: Plan): void {
    Assert.ok(
      plan.placeholders.length === 0,
      `WireLcoImportTool: an import against external outposts takes real values only — set ${plan.placeholders
        .map(placeholder => placeholder.setting)
        .join(", ")}`
    )
  }

  /**
   * The depot chain code of the plan's chain a table row's chain-kind cell names, else the
   * raw cell, so a row on a chain the plan lacks still shows when compared to the plan.
   *
   * @param chainPlans - The plan's chains.
   * @param kind - The row's chain-kind cell, as the node returns it (name or number).
   * @param kindEnum - The table's generated chain-kind enum (`SysioSyndChainkind`).
   * @returns The chain code, or the raw cell.
   */
  export function chainCodeOf<Kind>(
    chainPlans: ChainPlan[],
    kind: Kind,
    kindEnum: Record<string | number, string | number>
  ): string {
    return asOption(
      chainPlans.find(chainPlan =>
        matchesProtoEnum(kind, kindEnum, chainPlan.chain)
      )
    )
      .map(chainPlan => chainPlan.pool.chainCode)
      .getOrElse(String(kind))
  }

  /** The total of a chain's syndicated positions, in the liq token's depot subunits. */
  export function syndicatedTotal(
    syndications: ChainPlan["syndications"]
  ): bigint {
    return syndications.reduce((sum, spec) => sum + spec.amount, 0n)
  }

  /** The total of a chain's WIRE claims, in WIRE subunits. */
  export function claimTotal(chainPlan: ChainPlan): bigint {
    return chainPlan.claims.reduce(
      (sum, credit) => sum + BigInt(credit.wire_atomic),
      0n
    )
  }

  /**
   * The WIRE every pool of the plan drains from the `sysio` treasury: its T5 DEX earmark
   * (`BootstrapPlatformConfig.t5_dex_allocation`).
   *
   * @param plan - The import's plan.
   * @returns The total of the pools' WIRE sides, in WIRE subunits.
   */
  export function dexEarmark(plan: Plan): bigint {
    return chainPlans(plan).reduce(
      (sum, chainPlan) => sum + chainPlan.pool.initialWireAmount,
      0n
    )
  }

  /** The total of every chain's WIRE claims — what `sysio.dclaim` must be funded with. */
  export function planClaimTotal(plan: Plan): bigint {
    return chainPlans(plan).reduce(
      (sum, chainPlan) => sum + claimTotal(chainPlan),
      0n
    )
  }

  /**
   * The number of batches `length` credits split into.
   *
   * @param length - The credit count.
   * @param batchSize - Credits per batch.
   * @returns The batch count.
   */
  export function batchCount(length: number, batchSize: number): number {
    return Math.ceil(length / batchSize)
  }

  /**
   * The number of credits batch `index` of `length` credits carries, without building it.
   *
   * @param length - The credit count.
   * @param batchSize - Credits per batch.
   * @param index - The batch index, from 0, below {@link batchCount}.
   * @returns The batch's credit count.
   */
  export function batchCreditCount(
    length: number,
    batchSize: number,
    index: number
  ): number {
    return Math.min(batchSize, length - index * batchSize)
  }

  /**
   * One `sysio.synd::importsynd` push of a chain's positions.
   *
   * @param chainPlan - The chain's plan.
   * @param index - The batch index, from 0.
   * @returns The generated action data.
   * @throws When the batch is past the last.
   */
  export function syndicationBatch(
    chainPlan: ChainPlan,
    index: number
  ): SysioContracts.SysioSyndImportsyndAction {
    const specs = assertBatch(
      chainPlan.syndications,
      index,
      SyndicationBatchSize
    )
    return {
      chain_code: chainPlan.pool.chainCode,
      token_code: chainPlan.pool.tokenCode,
      credits: specs.map(spec => ({
        pubkey: nativeBytesHex(chainPlan.chain, spec.pubkey),
        amount: spec.amount.toString()
      }))
    }
  }

  /**
   * One `sysio.dclaim::importseed` push of a chain's claims.
   *
   * @param chainPlan - The chain's plan.
   * @param index - The batch index, from 0.
   * @returns The generated action data.
   * @throws When the batch is past the last.
   */
  export function claimBatch(
    chainPlan: ChainPlan,
    index: number
  ): SysioContracts.SysioDclaimImportseedAction {
    return {
      // proto ChainKind → the dclaim ABI's own enum, bridged by VALUE.
      chain: abiEnumValue(SysioDclaimChainkind, chainPlan.chain),
      credits: assertBatch(chainPlan.claims, index, ClaimBatchSize)
    }
  }

  /**
   * The `sysio.liq::regliqpool` data of a chain's pool.
   *
   * @param chainPlan - The chain's plan.
   * @returns The generated action data.
   */
  export function poolRegistration(
    chainPlan: ChainPlan
  ): SysioContracts.SysioLiqRegliqpoolAction {
    const { pool } = chainPlan
    return {
      chain_code: pool.chainCode,
      token_code: pool.tokenCode,
      pair_symbol: Constants.liqSymbol(pool.pairSymbol),
      initial_chain_amount: pool.initialChainAmount.toString(),
      initial_wire_amount: pool.initialWireAmount.toString(),
      fee: pool.fee,
      locked_shares: pool.lockedShares.toString(),
      conversion_horizon_sec: pool.conversionHorizonSec,
      depth_cap_bps: pool.depthCapBps,
      clip_floor: pool.clipFloor.toString()
    }
  }

  /**
   * A plan's counts, totals, placeholders and digest.
   *
   * @param plan - The import's plan.
   * @returns The summary.
   */
  export function summarize(plan: Plan): Summary {
    return {
      ethereum: plan.ethereum == null ? null : summarizeChain(plan.ethereum),
      solana: plan.solana == null ? null : summarizeChain(plan.solana),
      dclaimFundingAccount: plan.dclaimFundingAccount,
      placeholders: plan.placeholders,
      digest: planDigest(plan)
    }
  }

  /**
   * The plan as the launch `BootstrapPlatformConfig` it imports: every pool and syndicated
   * position, with the T5 DEX earmark set to exactly the pools' WIRE (chains and tokens are
   * the registry's, not the import's).
   *
   * @param plan - The import's plan.
   * @param network - The deployment label the record names.
   * @returns The record.
   */
  export function toBootstrapPlatformConfig(
    plan: Plan,
    network: string
  ): BootstrapPlatformConfig {
    const chains = chainPlans(plan),
      liqPools = chains.map(chainPlan => chainPlan.pool)
    return BootstrapPlatformConfig.create({
      schemaVersion: RecordSchemaVersion,
      network,
      t5DexAllocation: dexEarmark(plan),
      liqPools,
      syndications: chains.flatMap(chainPlan => chainPlan.syndications)
    })
  }

  /**
   * The record as authored-config JSON: proto field names, amounts quoted.
   *
   * @param record - The record.
   * @returns The JSON text.
   */
  export function serializeRecord(record: BootstrapPlatformConfig): string {
    return BootstrapPlatformConfig.toJsonString(record, {
      useProtoFieldName: true,
      prettySpaces: RecordIndent
    })
  }

  // ── derivation ──────────────────────────────────────────────────────────

  /** Derive the Ethereum outpost's plan from its opp-snapshot export. */
  function createEthereumPlan(
    chainConfig: LcoImportChainConfig
  ): ChainDerivation {
    const file = chainConfig.bootstrapJsonFile,
      { snapshot } = readExport(EthereumGenesisSnapshotSchemaCodec, file),
      chainCode = Constants.ETHEREUM_CHAIN_CODENAME,
      tokenCode = Constants.liqTokenCode(chainCode),
      positions = snapshot.stakers
        .map(staker => ({
          staker,
          amount: scaleUnits(
            BigInt(staker.netPrincipal),
            EthereumDecimals,
            Constants.LIQ_TOKEN_PRECISION
          )
        }))
        .filter(({ amount }) => amount > 0n),
      unkeyed = positions
        .filter(({ staker }) => staker.pubkey == null)
        .map(({ staker }) => staker.address),
      // The outpost syndicates only from the key of the staking address, so a key that
      // is not would credit the position to someone else.
      misKeyed = snapshot.stakers
        .filter(
          staker =>
            staker.pubkey != null && !isKeyOf(staker.pubkey, staker.address)
        )
        .map(staker => staker.address)
    Assert.ok(
      unkeyed.length === 0,
      `WireLcoImportTool: ${file}: ${unkeyed.length} staker(s) hold liqETH with no recovered pubkey, which no import can credit: ${unkeyed.join(", ")}`
    )
    Assert.ok(
      misKeyed.length === 0,
      `WireLcoImportTool: ${file}: ${misKeyed.length} staker(s) carry a pubkey that is not their address's key: ${misKeyed.join(", ")}`
    )
    // An address may be both a staker and a purchaser, but only once in each list.
    assertUnique(
      file,
      "stakers",
      snapshot.stakers.map(staker => evmDisplayHex(staker.address))
    )
    assertUnique(
      file,
      "purchasers",
      snapshot.purchasers.map(purchaser => evmDisplayHex(purchaser.address))
    )
    assertRowTotals(
      file,
      snapshot.purchasers.map(purchaser => ({
        address: purchaser.address,
        declared: purchaser.totalPretokens,
        derived: BigInt(purchaser.pretokens) + BigInt(purchaser.pretokenYield)
      }))
    )
    const staked = sumOf(snapshot.stakers.map(staker => staker.netPrincipal))
    assertTotals(file, {
      "metadata.totalPrincipal": {
        declared: snapshot.metadata.totalPrincipal,
        derived: staked
      },
      "metadata.totalLiqEthStaked": {
        declared: snapshot.metadata.totalLiqEthStaked,
        derived: staked
      },
      "metadata.totalLiqEthPurchased": {
        declared: snapshot.metadata.totalLiqEthPurchased,
        derived: sumOf(
          snapshot.purchasers.map(purchaser => purchaser.liqPrincipalIn)
        )
      }
    })
    const syndications = sortSyndications(
        positions.map(({ staker, amount }) =>
          SyndicationSpec.create({
            chainCode,
            tokenCode,
            pubkey: evmDisplayHex(staker.pubkey),
            amount
          })
        )
      ),
      { lastPoolLiqBalance, totalLiqEthPurchased, highestTranchePriceUsd } =
        snapshot.metadata,
      // The imported positions in wei plus the purchases, so the pool gets exactly the
      // purchases once custody is floored to the depot precision.
      bookedPlaceholder =
        scaleUnits(
          syndicatedTotal(syndications),
          Constants.LIQ_TOKEN_PRECISION,
          EthereumDecimals
        ) + BigInt(totalLiqEthPurchased),
      bookedWei =
        lastPoolLiqBalance == null ? bookedPlaceholder : BigInt(lastPoolLiqBalance),
      bookedPlaceholders: Placeholder[] =
        lastPoolLiqBalance == null
          ? [
              {
                setting: `${file}: metadata.lastPoolLiqBalance`,
                value: bookedPlaceholder.toString()
              }
            ]
          : [],
      { pool, placeholders } = createPool({
        chainConfig,
        member: "ethereum",
        chainCode,
        tokenCode,
        custodyTotal: scaleUnits(
          bookedWei,
          EthereumDecimals,
          Constants.LIQ_TOKEN_PRECISION
        ),
        syndications,
        exportedTranchePriceUsd: highestTranchePriceUsd,
        placeholderNativePriceUsd: PlaceholderEthereumPriceUsd
      }),
      claims = createClaims(
        [
          ...snapshot.purchasers.map(purchaser => ({
            nativeAddress: nativeBytesHex(ChainKind.EVM, purchaser.address),
            amount: BigInt(purchaser.totalPretokens)
          })),
          ...snapshot.stakers.map(staker => ({
            nativeAddress: nativeBytesHex(ChainKind.EVM, staker.address),
            amount: BigInt(staker.pretokenYield)
          }))
        ],
        EthereumDecimals
      )
    return {
      plan: {
        chain: ChainKind.EVM,
        bootstrapJsonFile: file,
        syndications,
        claims,
        pool
      },
      placeholders: [...bookedPlaceholders, ...placeholders]
    }
  }

  /** Derive the Solana outpost's plan from its genesis export. */
  function createSolanaPlan(chainConfig: LcoImportChainConfig): ChainDerivation {
    const file = chainConfig.bootstrapJsonFile,
      { text, snapshot } = readExport(SolanaGenesisSnapshotSchemaCodec, file),
      { accounting } = snapshot,
      { units } = accounting,
      chainCode = Constants.SOLANA_CHAIN_CODENAME,
      tokenCode = Constants.liqTokenCode(chainCode),
      toDepot = (amount: string): bigint =>
        scaleUnits(
          BigInt(amount),
          units.liqsolDecimals,
          Constants.LIQ_TOKEN_PRECISION
        )
    const { balances } = snapshot,
      allocationHash = solanaAllocationHash(text),
      poolBalance = BigInt(accounting.poolBalance),
      unreported = BigInt(accounting.unreportedLiqsolYield)
    Assert.ok(
      accounting.issues.length === 0,
      `WireLcoImportTool: ${file}: the export reports reconciliation issues: ${accounting.issues.join("; ")}`
    )
    Assert.strictEqual(
      allocationHash,
      snapshot.allocationHash,
      `WireLcoImportTool: ${file}: the balances hash to ${allocationHash}, not the declared allocationHash ${snapshot.allocationHash}`
    )
    assertUnique(
      file,
      "balances",
      balances.map(balance => balance.address)
    )
    assertRowTotals(
      file,
      balances.map(balance => ({
        address: balance.address,
        declared: balance.totalPretokens,
        derived:
          BigInt(balance.directlyPurchasedPretokens) +
          BigInt(balance.pretokenYield)
      }))
    )
    Assert.ok(
      poolBalance >= unreported,
      `WireLcoImportTool: ${file}: the pool's ${poolBalance} liqSOL is less than its ${unreported} unreported yield`
    )
    assertTotals(file, {
      // The pool's principal is the wallets' purchased liqSOL, which the settlement ledger books.
      "accounting.initialChainAmount": {
        declared: accounting.initialChainAmount,
        derived: sumOf(balances.map(balance => balance.purchasedLiqsol))
      },
      "accounting.backingAvailable": {
        declared: accounting.backingAvailable,
        derived: poolBalance - unreported
      },
      "accounting.directlyPurchasedPretokens": {
        declared: accounting.directlyPurchasedPretokens,
        derived: sumOf(balances.map(balance => balance.directlyPurchasedPretokens))
      },
      "accounting.allocatedPretokenYield": {
        declared: accounting.allocatedPretokenYield,
        derived: sumOf(balances.map(balance => balance.pretokenYield))
      },
      "accounting.totalUserPretokens": {
        declared: accounting.totalUserPretokens,
        derived: sumOf(balances.map(balance => balance.totalPretokens))
      },
      // The pool's pretokens may hold yield no wallet was allocated yet, so the sold total
      // is checked through them rather than against the users' total.
      "accounting.poolPretokens": {
        declared: accounting.poolPretokens,
        derived: sumOf([
          accounting.allocatedPretokenYield,
          accounting.unallocatedPoolPretokens
        ])
      },
      "accounting.totalPretokensSold": {
        declared: accounting.totalPretokensSold,
        derived: sumOf([
          accounting.directlyPurchasedPretokens,
          accounting.poolPretokens
        ])
      }
    })
    const syndications = sortSyndications(
        snapshot.balances
          .map(balance =>
            SyndicationSpec.create({
              chainCode,
              tokenCode,
              pubkey: balance.address,
              amount: toDepot(balance.syndicatedLiqsol)
            })
          )
          .filter(spec => spec.amount > 0n)
      ),
      // The PostLaunch flip books exactly staked plus purchased principal; minting the
      // custody slack too would create LIQSOL the settlement ledger cannot pay out.
      custodyTotal =
        toDepot(accounting.initialChainAmount) + syndicatedTotal(syndications),
      backing = toDepot(accounting.backingAvailable)
    Assert.ok(
      custodyTotal <= backing,
      `WireLcoImportTool: ${file}: the booked principal ${custodyTotal} exceeds the ${backing} the pool can back`
    )
    const { pool, placeholders } = createPool({
        chainConfig,
        member: "solana",
        chainCode,
        tokenCode,
        custodyTotal,
        syndications,
        exportedTranchePriceUsd: accounting.highestTranchePriceUsd,
        placeholderNativePriceUsd: PlaceholderSolanaPriceUsd
      }),
      claims = createClaims(
        snapshot.balances.map(balance => ({
          nativeAddress: nativeBytesHex(ChainKind.SVM, balance.address),
          amount: BigInt(balance.totalPretokens)
        })),
        units.pretokenDecimals
      )
    return {
      plan: {
        chain: ChainKind.SVM,
        bootstrapJsonFile: file,
        programId: snapshot.programId,
        syndications,
        claims,
        pool
      },
      placeholders
    }
  }

  /**
   * Derive a chain's pool: the LCO liq is the booked custody less every syndicated
   * position, and its WIRE side carries the same USD value at the highest tranche price.
   */
  function createPool(source: PoolSource): PoolDerivation {
    const { chainCode, tokenCode, custodyTotal, chainConfig, member } = source,
      syndicated = syndicatedTotal(source.syndications),
      initialChainAmount = custodyTotal - syndicated
    Assert.ok(
      initialChainAmount > 0n,
      `WireLcoImportTool: ${chainConfig.bootstrapJsonFile}: the booked custody ${custodyTotal} does not exceed the syndicated ${syndicated}, so no LCO liq is left for the ${tokenCode} pool`
    )
    const { pricing, placeholders: pricingPlaceholders } = resolvePricing(source),
      initialWireAmount =
        (initialChainAmount * pricing.nativePriceUsd) /
        pricing.highestTranchePriceUsd,
      // The persisted slot is `null` when unset, which a destructuring default would keep.
      tuning = asOption(chainConfig.pool).getOrElse(PlaceholderPoolTuning)
    assertTuningOnly(tuning, member)
    const pool = LiqPoolSpec.create({
      chainCode,
      tokenCode,
      pairSymbol: Constants.liqPoolPairCode(tokenCode),
      name: tuning.name || poolName(tokenCode),
      description: tuning.description || poolDescription(tokenCode),
      initialChainAmount,
      initialWireAmount,
      fee: tuning.fee,
      lockedShares: tuning.lockedShares,
      conversionHorizonSec: tuning.conversionHorizonSec,
      depthCapBps: tuning.depthCapBps,
      clipFloor: tuning.clipFloor,
      custodyTotal
    })
    assertPool(pool)
    return {
      pool,
      placeholders: [
        ...pricingPlaceholders,
        ...(chainConfig.pool == null
          ? [
              {
                setting: `lcoImport.${member}.pool`,
                value: LiqPoolSpec.toJsonString(PlaceholderPoolTuning)
              }
            ]
          : [])
      ]
    }
  }

  /**
   * The prices a pool's WIRE side is computed at. The highest tranche price may come from
   * the options or the export; both naming different prices is refused.
   */
  function resolvePricing(source: PoolSource): PoolPricingDerivation {
    const { chainConfig, member, exportedTranchePriceUsd } = source,
      configuredTranche = chainConfig.highestTranchePriceUsd
    Assert.ok(
      configuredTranche == null ||
        exportedTranchePriceUsd == null ||
        BigInt(configuredTranche) === BigInt(exportedTranchePriceUsd),
      `WireLcoImportTool: lcoImport.${member}.highestTranchePriceUsd ${configuredTranche} disagrees with the export's ${exportedTranchePriceUsd}`
    )
    const nativePriceUsd = asOption(chainConfig.nativePriceUsd).getOrElse(
        source.placeholderNativePriceUsd
      ),
      highestTranchePriceUsd =
        configuredTranche ??
        exportedTranchePriceUsd ??
        PlaceholderHighestTranchePriceUsd,
      placeholders: Placeholder[] = [
        ...(chainConfig.nativePriceUsd == null
          ? [
              {
                setting: `lcoImport.${member}.nativePriceUsd`,
                value: nativePriceUsd
              }
            ]
          : []),
        ...(configuredTranche == null && exportedTranchePriceUsd == null
          ? [
              {
                setting: `lcoImport.${member}.highestTranchePriceUsd`,
                value: highestTranchePriceUsd
              }
            ]
          : [])
      ]
    Assert.ok(
      BigInt(highestTranchePriceUsd) > 0n,
      `WireLcoImportTool: the ${member} highest tranche price must be positive`
    )
    return {
      pricing: {
        nativePriceUsd: BigInt(nativePriceUsd),
        highestTranchePriceUsd: BigInt(highestTranchePriceUsd)
      },
      placeholders
    }
  }

  /**
   * Refuse pool options that set a value the import derives itself: the chain, token,
   * pair, either seed or the custody.
   */
  function assertTuningOnly(tuning: LiqPoolSpec, member: string): void {
    const derived = [
      tuning.chainCode !== "" ? "chainCode" : null,
      tuning.tokenCode !== "" ? "tokenCode" : null,
      tuning.pairSymbol !== "" ? "pairSymbol" : null,
      tuning.initialChainAmount !== 0n ? "initialChainAmount" : null,
      tuning.initialWireAmount !== 0n ? "initialWireAmount" : null,
      tuning.custodyTotal !== 0n ? "custodyTotal" : null
    ].filter(field => field != null)
    Assert.ok(
      derived.length === 0,
      `WireLcoImportTool: lcoImport.${member}.pool sets ${derived.join(", ")}, which the import derives from the export`
    )
  }

  /** Check a pool against the launch config's pool invariants (V11, V13) and the asset range. */
  function assertPool(pool: LiqPoolSpec): void {
    const label = `WireLcoImportTool: the ${pool.tokenCode} pool`
    Assert.ok(
      PairCodePattern.test(pool.pairSymbol),
      `${label}: pair code ${pool.pairSymbol} must be 1..7 capitals`
    )
    Assert.ok(
      pool.initialWireAmount > 0n,
      `${label}: its WIRE side rounds to nothing`
    )
    Assert.ok(
      pool.initialChainAmount < PoolSeedLimit &&
        pool.initialWireAmount < PoolSeedLimit,
      `${label}: a seed reaches sysio.swap's ${PoolSeedLimit} limit (liq ${pool.initialChainAmount}, WIRE ${pool.initialWireAmount})`
    )
    // The shadow's supply reaches the whole booked custody once every position is imported.
    Assert.ok(
      pool.custodyTotal <= AssetMaxAmount,
      `${label}: its booked custody ${pool.custodyTotal} exceeds the asset range`
    )
    Assert.ok(pool.fee <= MaxPoolFee, `${label}: fee ${pool.fee} exceeds ${MaxPoolFee}`)
    Assert.ok(
      pool.conversionHorizonSec > 0,
      `${label}: conversionHorizonSec must be positive`
    )
    Assert.ok(
      pool.depthCapBps >= 1 && pool.depthCapBps <= MaxDepthCapBps,
      `${label}: depthCapBps ${pool.depthCapBps} must be 1..${MaxDepthCapBps}`
    )
    Assert.ok(
      pool.clipFloor > 0n && pool.clipFloor <= AssetMaxAmount,
      `${label}: clipFloor must be positive and within the asset range`
    )
    // `inittoken` mints isqrt(liq × WIRE) shares and keeps at least one for the creator.
    const shares = isqrt(pool.initialChainAmount * pool.initialWireAmount)
    Assert.ok(
      pool.lockedShares < shares,
      `${label}: lockedShares ${pool.lockedShares} must stay below the ${shares} minted pool shares`
    )
  }

  /** A declared total and what the exporter derives it from. */
  interface DeclaredTotal {
    readonly declared: string
    readonly derived: bigint
  }

  /** One row's declared total and what its components add up to. */
  interface RowTotal extends DeclaredTotal {
    readonly address: string
  }

  /** The total of decimal-string amounts. */
  function sumOf(amounts: string[]): bigint {
    return amounts.reduce((sum, amount) => sum + BigInt(amount), 0n)
  }

  /**
   * Refuse an export whose declared totals disagree with what the exporter derives them from:
   * its rows or its other totals. A mismatch means a broken or edited file.
   */
  function assertTotals(
    file: string,
    totals: Record<string, DeclaredTotal>
  ): void {
    const wrong = Object.entries(totals)
      .filter(([, { declared, derived }]) => BigInt(declared) !== derived)
      .map(
        ([setting, { declared, derived }]) =>
          `${setting} ${declared} (derived: ${derived})`
      )
    Assert.ok(
      wrong.length === 0,
      `WireLcoImportTool: ${file}: declared totals do not add up: ${wrong.join("; ")}`
    )
  }

  /**
   * Refuse an export list naming one identity twice. The exporters write one row per
   * address, and the import would credit a repeated row again.
   */
  function assertUnique(file: string, list: string, identities: string[]): void {
    const repeated = Object.entries(countBy(identities))
      .filter(([, count]) => count > 1)
      .map(([identity]) => identity)
    Assert.ok(
      repeated.length === 0,
      `WireLcoImportTool: ${file}: ${list} lists ${repeated.length} address(es) more than once: ${repeated.join(", ")}`
    )
  }

  /** Refuse an export with a row whose `totalPretokens` is not the sum of its parts. */
  function assertRowTotals(file: string, rows: RowTotal[]): void {
    const wrong = rows
      .filter(({ declared, derived }) => BigInt(declared) !== derived)
      .map(({ address }) => address)
    Assert.ok(
      wrong.length === 0,
      `WireLcoImportTool: ${file}: ${wrong.length} row(s) whose totalPretokens is not its pretokens plus pretokenYield: ${wrong.join(", ")}`
    )
  }

  /**
   * The positions sorted by pubkey, each within the asset range. Each address holds one row,
   * so each pubkey holds one position.
   */
  function sortSyndications(specs: SyndicationSpec[]): SyndicationSpec[] {
    specs.forEach(spec =>
      Assert.ok(
        spec.amount <= AssetMaxAmount,
        `WireLcoImportTool: the ${spec.tokenCode} position of ${spec.pubkey} exceeds the asset range`
      )
    )
    return sortBy(specs, spec => spec.pubkey)
  }

  /**
   * One WIRE claim per native address: owed amounts summed per address, converted to WIRE
   * at one pretoken per WIRE, zero claims dropped, sorted by address.
   */
  function createClaims(owed: Owed[], pretokenDecimals: number): ClaimCredit[] {
    const totals = owed.reduce(
        (byAddress, entry) =>
          byAddress.set(
            entry.nativeAddress,
            (byAddress.get(entry.nativeAddress) ?? 0n) + entry.amount
          ),
        new Map<string, bigint>()
      ),
      claims = [...totals.entries()]
        .map(([nativeAddress, amount]) => ({
          native_address: nativeAddress,
          wire_atomic: scaleUnits(
            amount,
            pretokenDecimals,
            Constants.WIRE_PRECISION
          ).toString()
        }))
        .filter(claim => BigInt(claim.wire_atomic) > 0n)
    claims.forEach(claim =>
      Assert.ok(
        BigInt(claim.wire_atomic) <= AssetMaxAmount,
        `WireLcoImportTool: the WIRE claim of ${claim.native_address} exceeds the asset range`
      )
    )
    return sortBy(claims, claim => claim.native_address)
  }

  /** Read and validate one export, naming the file in any failure. */
  function readExport<T>(codec: SchemaCodec<T>, file: string): ExportRead<T> {
    const text = Either.try(() => Fs.readFileSync(file, "utf-8"))
      .ifLeft(error => {
        throw new NestedError(`WireLcoImportTool: cannot read the export ${file}`, {
          cause: error,
          context: { file }
        })
      })
      .getOrThrow()
    const snapshot = Either.try(() => codec.deserialize(text))
      .ifLeft(error => {
        throw new NestedError(`WireLcoImportTool: ${file} is not a valid export`, {
          cause: error,
          context: { file }
        })
      })
      .getOrThrow()
    return { text, snapshot }
  }

  /**
   * The `allocationHash` capital-index computes for a Solana genesis export: SHA-256 over the
   * compact JSON of its `schemaVersion`, `programId` and `balances`, in the export's own
   * key order (`SolanaOppBalanceService`).
   *
   * @param text - The export's JSON text.
   * @returns The lowercase hex digest.
   */
  export function solanaAllocationHash(text: string): string {
    const { schemaVersion, programId, balances } = JSON.parse(
      text
    ) as SolanaGenesisSnapshot
    return createHash("sha256")
      .update(JSON.stringify({ schemaVersion, programId, balances }))
      .digest("hex")
  }

  /** Whether the compressed secp256k1 `pubkey` is the key of the EVM `address`. */
  function isKeyOf(pubkey: string, address: string): boolean {
    return getValue(
      () =>
        ethers.computeAddress(evmDisplayHex(pubkey)).toLowerCase() ===
        address.toLowerCase(),
      false
    )
  }

  /** Batch `index` of `items`, refusing one past the last. */
  function assertBatch<T>(items: T[], index: number, batchSize: number): T[] {
    const batch = items.slice(index * batchSize, (index + 1) * batchSize)
    Assert.ok(
      batch.length > 0,
      `WireLcoImportTool: batch ${index} is past the last of ${batchCount(items.length, batchSize)}`
    )
    return batch
  }

  /** A chain's summary: counts and totals as decimal strings. */
  function summarizeChain(chainPlan: ChainPlan): ChainSummary {
    return {
      bootstrapJsonFile: chainPlan.bootstrapJsonFile,
      syndicationCount: chainPlan.syndications.length,
      syndicatedTotal: syndicatedTotal(chainPlan.syndications).toString(),
      claimCount: chainPlan.claims.length,
      claimTotal: claimTotal(chainPlan).toString(),
      poolChainAmount: chainPlan.pool.initialChainAmount.toString(),
      poolWireAmount: chainPlan.pool.initialWireAmount.toString()
    }
  }

  /**
   * The display name of a liq token's LCO pool, unless its options name it.
   *
   * @param tokenCode - The liq token code (`LIQSOL`).
   * @returns The name (`LIQSOL/WIRE yield pool`).
   */
  export function poolName(tokenCode: string): string {
    return `${tokenCode}/WIRE yield pool`
  }

  /**
   * The description of a liq token's LCO pool, unless its options describe it.
   *
   * @param tokenCode - The liq token code (`LIQSOL`).
   * @returns The description.
   */
  export function poolDescription(tokenCode: string): string {
    return `The LCO ${tokenCode} against WIRE at the highest tranche price`
  }

  /**
   * Rescale an amount between decimal precisions, flooring when precision drops.
   *
   * @param amount - The amount at `fromDecimals`.
   * @param fromDecimals - Its precision.
   * @param toDecimals - The target precision.
   * @returns The amount at `toDecimals`.
   */
  export function scaleUnits(
    amount: bigint,
    fromDecimals: number,
    toDecimals: number
  ): bigint {
    return fromDecimals >= toDecimals
      ? amount / 10n ** BigInt(fromDecimals - toDecimals)
      : amount * 10n ** BigInt(toDecimals - fromDecimals)
  }

  /**
   * A native key or address as the raw-byte hex the depot actions take: an EVM value's
   * bytes, an SVM value's base58-decoded bytes.
   *
   * @param chain - The value's chain kind.
   * @param value - The value in display form.
   * @returns Lowercase hex, unprefixed.
   */
  export function nativeBytesHex(
    chain: ImportSeedChainKind,
    value: string
  ): string {
    const bytes =
      chain === ChainKind.EVM
        ? ethers.getBytes(evmDisplayHex(value))
        : new SolanaPublicKey(value).toBytes()
    return Buffer.from(bytes).toString("hex")
  }

  /**
   * A position's pubkey as `sysio.synd::importsynd` looks it up in `sysio.authex::links`: the
   * canonical `PUB_EM_` / `PUB_ED_` spelling whose hash the `bypubkey` index holds.
   *
   * @param chain - The position's chain kind.
   * @param pubkey - The pubkey in display form.
   * @returns The canonical key string.
   */
  export function linkKey(chain: ImportSeedChainKind, pubkey: string): string {
    return PublicKey.from({
      type: LinkKeyTypes[chain],
      compressed: Buffer.from(nativeBytesHex(chain, pubkey), "hex")
    }).toString()
  }

  /**
   * A `sysio.authex::links` row's `pub_key` in {@link linkKey}'s spelling. nodeop renders an EM
   * key as unprefixed uncompressed hex (`PUB_EM_04…`), while `bypubkey` hashes it compressed.
   *
   * @param pubKey - The row's `pub_key`, as the node returns it.
   * @returns The canonical key string.
   */
  export function linkRowKey(pubKey: string): string {
    const key = PublicKey.from(pubKey)
    return match(key.type)
      .with(KeyType.EM, () =>
        PublicKey.from({
          type: KeyType.EM,
          compressed: Buffer.from(
            getCompressedPublicKey(
              Buffer.from(key.data.array).toString("hex"),
              KeyType.EM
            ),
            "hex"
          )
        }).toString()
      )
      .otherwise(() => key.toString())
  }

  /**
   * An EVM hex value in display form: `0x`-prefixed, lowercase.
   *
   * @param value - The value, with or without the prefix.
   * @returns The display form.
   */
  export function evmDisplayHex(value: string): string {
    return `${EvmHexPrefix}${value.replace(EvmHexPrefixPattern, "").toLowerCase()}`
  }
}
