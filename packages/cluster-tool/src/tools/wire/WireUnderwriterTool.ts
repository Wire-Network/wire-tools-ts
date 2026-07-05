/**
 * WireUnderwriterTool — the underwriter collateral surface. The pure VALUE
 * helpers (defaults / JSON-config parsing) compute the per-underwriter collateral
 * plan; {@link WireUnderwriterTool.planCollateralDeposit} is the orchestration-unit factory that
 * turns that plan into a {@link ClusterBuildPhaseGroup} of per-underwriter
 * {@link ClusterBuildPhase}s, each holding the per-`(chain, token)` deposit Steps
 * (so the `Report` records every individual bond). Every on-chain WRITE is its own
 * Step, delegated to the chain-specific collateral / funding tools; the plan
 * computation stays plain functions used INSIDE the factory.
 *
 * The underwriter accounts are ASSUMED already provisioned into THE cluster
 * key store (`ctx.keyStore` — their typed ETH + SOL keys ride each
 * {@link OperatorAccount}); wiring that provisioning is the bootstrap / flow `beforeAll`
 * concern — this tool only returns the deposit PhaseGroup.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import { match } from "ts-pattern"

import {
  ChainKind,
  OperatorType,
  TokenAmount,
  TokenKind
} from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"
import { getLogger, getValue } from "@wireio/shared"
import type { ChainTokenAmount } from "@wireio/debugging-shared"

import type { ClusterConfig } from "../../config/ClusterConfig.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../../orchestration/ClusterBuildPhase.js"
import { ClusterBuildPhaseGroup } from "../../orchestration/ClusterBuildPhaseGroup.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { ClusterBuildParent } from "../../orchestration/ClusterBuildPhaseBase.js"
import { Report } from "../../report/Report.js"
import { EthereumCollateralTool } from "../ethereum/EthereumCollateralTool.js"
import { EthereumFundingTool } from "../ethereum/EthereumFundingTool.js"
import { SolanaCollateralTool } from "../solana/SolanaCollateralTool.js"
import { SolanaFundingTool } from "../solana/SolanaFundingTool.js"

const log = getLogger(__filename)

/**
 * Underwriter collateral surface — defaults, JSON config parsing, and the deposit
 * PhaseGroup factory. Grouped together (rather than three sibling files) because
 * every entry point operates on the same `ChainTokenAmount[][]` shape and lives
 * under the same conceptual concern: "what bond should each underwriter post, and
 * how does the harness apply that plan?".
 */
export namespace WireUnderwriterTool {
  // ── Defaults (pure VALUE helpers) ───────────────────────────────────────

  /**
   * Default per-(chain, token) deposit amount when neither
   * `--underwriter-collateral-json-file` nor a programmatic override
   * is provided. The spec at "Underwriter Collateral Config for
   * `cluster-tool`" calls for `1000` of each token, but the
   * underlying chains have widely-varying smallest-unit conventions:
   * 1000 lamports on Solana sits below the rent-exempt threshold the
   * `opp_outpost::deposit` ix triggers when it resizes the
   * operator-registry PDA, so a literal-1000 default fails at
   * simulation time. The value here (`1_000_000_000` base units)
   * matches flow-batch-operator-termination's batch-operator deposit
   * (`FLOW_E_REQ_SOL_MIN_BOND`) and is the smallest amount
   * empirically known to clear PDA rent growth on Solana while
   * remaining negligible on Ethereum (1e9 wei = 10⁻⁹ ETH) and on
   * WIRE.
   *
   * Encoded as `bigint` to match the `TokenAmount.amount` proto
   * field (`@protobuf-ts/runtime` decodes `int64` as `bigint`).
   * Operators that need realistic magnitudes set
   * `--underwriter-collateral-json-file` with explicit per-leg
   * amounts.
   */
  export const DefaultAmount: bigint = 1_000_000_000n

  /**
   * Default (chain_code, token_code) slug_name pairs deposited to every
   * underwriter when no `--underwriter-collateral-json-file` is supplied.
   * Tracks the integrated-outpost set; if a new outpost is added (Sui, etc.),
   * add the corresponding `(chainCode, tokenCode)` pair here so the default
   * deposits cover it without requiring every caller to specify a config
   * file.
   */
  export const DefaultPairs: ReadonlyArray<{
    chainCode: number
    tokenCode: number
    /** Discriminant the per-chain deposit dispatch matches on. */
    chainKind: ChainKind
  }> = [
    {
      chainCode: SlugName.from("WIRE"),
      tokenCode: SlugName.from("WIRE"),
      chainKind: ChainKind.WIRE
    },
    {
      chainCode: SlugName.from("ETHEREUM"),
      tokenCode: SlugName.from("ETH"),
      chainKind: ChainKind.EVM
    },
    {
      chainCode: SlugName.from("SOLANA"),
      tokenCode: SlugName.from("SOL"),
      chainKind: ChainKind.SVM
    }
  ] as const

  /**
   * Reserve slug_name that the outpost `depositNonNative` writes pair a non-native
   * token against. All mock stablecoins register under the PRIMARY reserve.
   */
  export const PrimaryReserveCode: bigint = BigInt(SlugName.from("PRIMARY"))

  /**
   * Extra lamports (on top of the deposit amount) an underwriter's SOL keypair is
   * topped up to before a SOL deposit — covers tx fees + PDA/ATA rent headroom.
   * Matches the magnitude flow-batch-operator-termination's batch-op deposit airdrop
   * uses; generous enough that runs never stall on under-funded operator wallets.
   */
  export const SolAirdropHeadroomLamports: bigint = 5_000_000_000n

  /**
   * Build the default underwriter-collateral set: one
   * {@link ChainTokenAmount} per {@link DefaultPairs} entry, each
   * amounting to {@link DefaultAmount} base units.
   *
   * Each entry pairs the harness-local `chain_code` (slug_name / uint64) with
   * a proto-generated `TokenAmount` carrying the matching `token_code` +
   * `bigint` amount.
   *
   * @returns A fresh array (the caller may mutate without aliasing
   *   the defaults). Returns the per-underwriter list shape —
   *   fan-out to all underwriters happens in {@link load}.
   */
  export function buildDefault(): ChainTokenAmount[] {
    return DefaultPairs.map(({ chainCode, tokenCode }) => ({
      chain_code: chainCode,
      amount: TokenAmount.create({
        tokenCode: BigInt(tokenCode),
        amount: DefaultAmount
      })
    }))
  }

  // ── JSON config parsing (pure VALUE helpers) ────────────────────────────

  /**
   * Parse a JSON value (already loaded from disk) into the canonical
   * length-`underwriterCount` per-underwriter shape stored on
   * `ClusterConfig.underwriterCollateral`. The input value may be
   * in either of two shapes per the spec at "Underwriter Collateral
   * Config for `cluster-tool`":
   *
   *   * **Uniform** — `Array<ChainTokenAmount>`. Applied to every
   *     underwriter. Fan-out-expanded to `underwriterCount` copies.
   *   * **Varied** — `Array<Array<ChainTokenAmount>>`. Outer array
   *     length MUST equal `underwriterCount`; otherwise this
   *     throws.
   *
   * Both shapes are parsed via `@protobuf-ts/runtime` JSON serdes
   * against the proto-generated `TokenAmount` model, so callers get
   * full field-level validation without the harness re-implementing
   * the schema. The output preserves the hydrated proto-message
   * instances — `amount.amount` is a `bigint`.
   *
   * @param json             Already-parsed JSON value
   *                         (`JSON.parse(fileContents)`).
   * @param underwriterCount Number of underwriters in the cluster.
   * @returns Length-`underwriterCount` array, one entry-list per
   *   underwriter.
   * @throws If the input is neither uniform nor varied shape, OR
   *   if a varied input's outer length does not match
   *   `underwriterCount`, OR if any inner `ChainTokenAmount` fails
   *   proto-level validation.
   */
  export function parseJson(
    json: unknown,
    underwriterCount: number
  ): ChainTokenAmount[][] {
    Assert.ok(
      Array.isArray(json),
      "underwriter collateral JSON must be an array"
    )
    Assert.ok(
      underwriterCount > 0,
      `underwriterCount must be positive, got ${underwriterCount}`
    )

    const items = json as unknown[]
    if (items.length === 0) {
      // Treat an empty array as "use defaults" so an operator that
      // wants to drop in an empty file as a placeholder gets the
      // same shape they would have got with no flag at all.
      return Array.from({ length: underwriterCount }, () => buildDefault())
    }

    // Uniform vs varied detection: the inner element of a varied
    // input is itself an array; the inner element of a uniform
    // input is an object literal. We trust the first element shape
    // to discriminate (a mixed-shape input is malformed).
    const head = items[0]
    const isVaried = Array.isArray(head)

    if (isVaried) {
      Assert.ok(
        items.length === underwriterCount,
        `underwriter collateral (varied shape): outer array length ${items.length} ` +
          `must equal --underwriters (${underwriterCount})`
      )
      return items.map((entry, idx) => {
        Assert.ok(
          Array.isArray(entry),
          `underwriter collateral (varied shape): entry ${idx} must be an array`
        )
        return entry.map(raw => parseChainTokenAmountJson(raw))
      })
    }

    // Uniform shape: parse once, fan out to every underwriter.
    const uniform = items.map(raw => parseChainTokenAmountJson(raw))
    return Array.from({ length: underwriterCount }, () => uniform.slice())
  }

  /**
   * Resolve the final `ClusterConfig.underwriterCollateral` value
   * from the CLI surface. If a file path is supplied, it's read +
   * parsed via {@link parseJson}. Otherwise the defaults from
   * {@link buildDefault} are fanned out to every underwriter.
   *
   * @param filePath          Optional path to the JSON config file.
   *                          When nullish, defaults are used.
   * @param underwriterCount  Number of underwriters in the cluster.
   * @returns Length-`underwriterCount` array, one entry-list per
   *   underwriter.
   * @example
   *   // No file → defaults (DefaultAmount base units of
   *   // WIRE/ETH/SOL per underwriter).
   *   WireUnderwriterTool.load(null, 3)
   *   // With file → parsed per the file's shape (uniform or varied).
   *   WireUnderwriterTool.load("/path/to/file.json", 3)
   */
  export function load(
    filePath: string | null,
    underwriterCount: number
  ): ChainTokenAmount[][] {
    Assert.ok(
      underwriterCount > 0,
      `underwriterCount must be positive, got ${underwriterCount}`
    )
    if (!filePath) {
      return Array.from({ length: underwriterCount }, () => buildDefault())
    }
    Assert.ok(
      Fs.existsSync(filePath),
      `--underwriter-collateral-json-file: ${filePath} does not exist`
    )
    const raw = Fs.readFileSync(filePath, "utf8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(
        `--underwriter-collateral-json-file: ${filePath} is not valid JSON: ${
          (err as Error).message
        }`
      )
    }
    return parseJson(parsed, underwriterCount)
  }

  // ── Deposit PhaseGroup factory (RETURNS the orchestration unit) ─────────

  /**
   * Build the underwriter collateral-deposit {@link ClusterBuildPhaseGroup}: one
   * child {@link ClusterBuildPhase} per underwriter, each holding — per
   * `(chain, token)` collateral entry — the deposit Step(s). Every on-chain WRITE
   * is its own Step so the `Report` validates each individual bond:
   *
   *   * EVM native → {@link EthereumCollateralTool.planDeposit}.
   *   * EVM non-native (ERC-20) → {@link EthereumFundingTool.planErc20Mint} +
   *     {@link EthereumCollateralTool.planErc20Approval} +
   *     {@link EthereumCollateralTool.planNonNativeDeposit}.
   *   * SVM native → {@link SolanaFundingTool.planAirdrop} (fund the escrow) +
   *     {@link SolanaCollateralTool.planDeposit}.
   *   * SVM non-native (SPL) → {@link SolanaFundingTool.planAirdrop} +
   *     {@link SolanaFundingTool.planSplMint} + {@link SolanaCollateralTool.planNonNativeDeposit}.
   *   * WIRE → skipped (no outpost deposit path today).
   *
   * The deposit Steps resolve the operator identity from `ctx.keyStore`
   * ({@link ClusterKeyStore.assertOperator}); the accounts are ASSUMED already provisioned
   * (bootstrap / flow `beforeAll` concern). Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short PhaseGroup name.
   * @param description - Human-readable description.
   * @param options - Step option overrides threaded to every deposit Step.
   * @param underwriterAccounts - WIRE account names, one per collateral plan entry.
   * @param collateral - Per-underwriter collateral plan (from {@link load}); its
   *   length MUST equal `underwriterAccounts.length`.
   * @returns The self-registered deposit PhaseGroup.
   * @throws If `collateral.length !== underwriterAccounts.length`.
   */
  export function planCollateralDeposit<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    underwriterAccounts: string[],
    collateral: ChainTokenAmount[][]
  ): ClusterBuildPhaseGroup<C> {
    Assert.ok(
      collateral.length === underwriterAccounts.length,
      `WireUnderwriterTool.planCollateralDeposit: collateral plan length (${collateral.length}) ` +
        `must equal underwriter count (${underwriterAccounts.length})`
    )
    const config = parent.context.config
    const group = ClusterBuildPhaseGroup.create<C>(parent, name, description)
    underwriterAccounts.forEach((account, index) => {
      const steps = collateral[index].flatMap(entry =>
        planDepositStepsForEntry<C>(config, options, account, entry)
      )
      ClusterBuildPhase.create<C>(
        group,
        `${account}-collateral`,
        `underwriter ${account} collateral deposits`,
        steps
      )
    })
    return group
  }
}

// ── Module-internal plumbing (NOT exported from the namespace) ────────────

/**
 * Bootstrap-time slug_name ↔ enum routing tables. The on-chain data model uses
 * `slug_name` (uint64 packed) for chain and token primary keys; the harness
 * still has to dispatch to per-chain outpost deposit helpers and pass the
 * appropriate `ChainKind` / `TokenKind` enum value to outpost-side contract
 * code. These maps cover the bootstrap set; if/when more outposts come online,
 * extend with the matching entries.
 */
const ChainKindByCodename: ReadonlyMap<number, ChainKind> = new Map([
  [SlugName.from("WIRE"), ChainKind.WIRE],
  [SlugName.from("ETHEREUM"), ChainKind.EVM],
  [SlugName.from("SOLANA"), ChainKind.SVM]
])

const TokenKindByCodename: ReadonlyMap<number, TokenKind> = new Map([
  [SlugName.from("WIRE"), TokenKind.NATIVE],
  [SlugName.from("ETH"), TokenKind.NATIVE],
  [SlugName.from("SOL"), TokenKind.NATIVE],
  [SlugName.from("LIQETH"), TokenKind.LIQ],
  [SlugName.from("LIQSOL"), TokenKind.LIQ],
  // Mock stablecoins deployed by `deployLocal.ts` (ETH) /
  // `SolanaOutpostBootstrapper` (SOL). The depot's `Token` table assigns each
  // its own slug_name code per the v6 "TWO Token rows per cross-chain pair"
  // decision — same underlying asset on each chain but distinct codes so the
  // primary key doesn't collide.
  [SlugName.from("USDC"), TokenKind.ERC20],
  [SlugName.from("USDT"), TokenKind.ERC20],
  [SlugName.from("USDCSOL"), TokenKind.SPL],
  [SlugName.from("USDTSOL"), TokenKind.SPL]
])

/**
 * Resolve a packed `chain_code` slug_name to its protobuf `ChainKind` VM-family
 * discriminant. Falls back to `ChainKind.UNKNOWN` so unknown chains land in
 * the deposit-dispatch's "unsupported" branch and emit a structured warn
 * rather than throwing — the cluster shouldn't crash on a typo-encoded code.
 */
function chainKindForCodename(chainCode: number): ChainKind {
  return ChainKindByCodename.get(chainCode) ?? ChainKind.UNKNOWN
}

/**
 * Resolve a packed `token_code` slug_name to its protobuf `TokenKind`
 * token-standard discriminant. Falls back to `TokenKind.UNKNOWN` so
 * unrecognised tokens flow into the warn-and-continue branch rather than
 * triggering a hard failure.
 */
function tokenKindForCodename(tokenCode: number): TokenKind {
  return TokenKindByCodename.get(tokenCode) ?? TokenKind.UNKNOWN
}

/**
 * Parse one entry of the `cluster-config.json`-shaped `ChainTokenAmount`
 * JSON form back into the harness-local in-memory shape: `chain_code`
 * passes through as a plain `number`, `amount` is rehydrated through
 * `TokenAmount.fromJson` so the int64 amount restores to `bigint`.
 *
 * @throws if `raw` is not a `{ chain_code, amount }` object literal.
 */
function parseChainTokenAmountJson(raw: unknown): ChainTokenAmount {
  Assert.ok(
    raw && typeof raw === "object" && "chain_code" in raw && "amount" in raw,
    "ChainTokenAmount JSON must be a `{chain_code, amount}` object literal"
  )
  const r = raw as { chain_code: number; amount: unknown }
  return {
    chain_code: r.chain_code,
    amount: TokenAmount.fromJson(
      r.amount as Parameters<typeof TokenAmount.fromJson>[0]
    )
  }
}

/**
 * Compute the deposit Step(s) for one `(chain, token)` collateral entry — a pure
 * build-time dispatch on the entry's `ChainKind` / `TokenKind`. A read (the kind
 * lookup + any artifact resolution for non-native tokens) that decides which
 * Steps to emit runs directly here; each emitted Step is a validated on-chain
 * write recorded by the Report.
 */
function planDepositStepsForEntry<C extends ClusterBuildContext>(
  config: ClusterConfig,
  options: ClusterBuildStepOptions,
  account: string,
  entry: ChainTokenAmount
): ClusterBuildStep.Any<C>[] {
  Assert.ok(entry.amount, "WireUnderwriterTool: ChainTokenAmount.amount is required")
  const chainCode = BigInt(entry.chain_code),
    tokenCode = BigInt(entry.amount.tokenCode),
    tokenCodeNum = Number(entry.amount.tokenCode),
    chainName = SlugName.toString(entry.chain_code),
    tokenName = SlugName.toString(tokenCodeNum),
    chainKind = chainKindForCodename(entry.chain_code),
    tokenKind = tokenKindForCodename(tokenCodeNum),
    amount = entry.amount.amount

  if (amount <= 0n) return []

  return match({ chainKind, tokenKind })
    .with({ chainKind: ChainKind.EVM, tokenKind: TokenKind.NATIVE }, () =>
      planEthereumNativeSteps<C>(options, account, chainName, tokenName, tokenCode, amount)
    )
    .with({ chainKind: ChainKind.EVM }, () =>
      planEthereumNonNativeSteps<C>(
        options,
        account,
        chainName,
        tokenName,
        chainCode,
        tokenCode,
        amount
      )
    )
    .with({ chainKind: ChainKind.SVM, tokenKind: TokenKind.NATIVE }, () =>
      planSolanaNativeSteps<C>(options, account, chainName, tokenName, tokenCode, amount)
    )
    .with({ chainKind: ChainKind.SVM }, () =>
      planSolanaNonNativeSteps<C>(
        options,
        account,
        chainName,
        tokenName,
        chainCode,
        tokenCode,
        amount
      )
    )
    .with({ chainKind: ChainKind.WIRE }, () => {
      // WIRE collateral has no outpost-side deposit path today — the
      // OPP-attestation deposit credits live on external chains by construction.
      log.info(
        `[WireUnderwriterTool] ${account}: skipping WIRE/${tokenName} entry — ` +
          `no WIRE-native underwriter collateral deposit path yet`
      )
      return [] as ClusterBuildStep.Any<C>[]
    })
    .otherwise(() => {
      log.warn(
        `[WireUnderwriterTool] ${account}: skipping unsupported chain ${chainName}/${tokenName}`
      )
      return [] as ClusterBuildStep.Any<C>[]
    })
}

/** EVM native deposit — one `OperatorRegistry.deposit` write. */
function planEthereumNativeSteps<C extends ClusterBuildContext>(
  options: ClusterBuildStepOptions,
  account: string,
  chainName: string,
  tokenName: string,
  tokenCode: bigint,
  amount: bigint
): ClusterBuildStep.Any<C>[] {
  return [
    EthereumCollateralTool.planDeposit<C>(
      Report.Actor.Underwriter,
      `${account}-${chainName}-${tokenName}-deposit`,
      `deposit ${amount} ${tokenName} on ${chainName} (native)`,
      options,
      account,
      OperatorType.UNDERWRITER,
      tokenCode,
      amount
    )
  ]
}

/**
 * EVM non-native deposit — mint → approve → depositNonNative (three writes).
 * The step SET derives from config alone; the mock-token + OperatorRegistry
 * ADDRESSES are deploy artifacts the RUNNERS resolve at run time (they do not
 * exist when the build constructs its steps — the outpost deploys later in the
 * same build; the old factory-time read silently skipped every non-native leg).
 */
function planEthereumNonNativeSteps<C extends ClusterBuildContext>(
  options: ClusterBuildStepOptions,
  account: string,
  chainName: string,
  tokenName: string,
  chainCode: bigint,
  tokenCode: bigint,
  amount: bigint
): ClusterBuildStep.Any<C>[] {
  return [
    EthereumFundingTool.planErc20Mint<C>(
      Report.Actor.Underwriter,
      `${account}-${tokenName}-mint`,
      `mint ${amount} mock ${tokenName} to ${account}`,
      options,
      account,
      tokenName,
      amount
    ),
    EthereumCollateralTool.planErc20Approval<C>(
      Report.Actor.Underwriter,
      `${account}-${tokenName}-approve`,
      `approve ${amount} ${tokenName} to OperatorRegistry`,
      options,
      account,
      tokenName,
      amount
    ),
    EthereumCollateralTool.planNonNativeDeposit<C>(
      Report.Actor.Underwriter,
      `${account}-${chainName}-${tokenName}-deposit`,
      `deposit ${amount} ${tokenName} on ${chainName} (ERC-20)`,
      options,
      account,
      chainCode,
      tokenCode,
      WireUnderwriterTool.PrimaryReserveCode,
      OperatorType.UNDERWRITER,
      amount
    )
  ]
}

/** SVM native deposit — airdrop the escrow, then one `opp-outpost::deposit` write. */
function planSolanaNativeSteps<C extends ClusterBuildContext>(
  options: ClusterBuildStepOptions,
  account: string,
  chainName: string,
  tokenName: string,
  tokenCode: bigint,
  amount: bigint
): ClusterBuildStep.Any<C>[] {
  return [
    SolanaFundingTool.planAirdrop<C>(
      Report.Actor.Underwriter,
      `${account}-${chainName}-airdrop`,
      `fund ${account} SOL keypair for the ${tokenName} deposit`,
      options,
      account,
      amount + WireUnderwriterTool.SolAirdropHeadroomLamports
    ),
    SolanaCollateralTool.planDeposit<C>(
      Report.Actor.Underwriter,
      `${account}-${chainName}-${tokenName}-deposit`,
      `deposit ${amount} ${tokenName} on ${chainName} (native)`,
      options,
      account,
      OperatorType.UNDERWRITER,
      tokenCode,
      amount
    )
  ]
}

/**
 * SVM non-native deposit — airdrop → mint SPL → depositNonNative. The step SET
 * derives from config alone; the SPL mint ADDRESS is a deploy artifact the
 * RUNNERS resolve at run time (`sol-mock-mints.json` does not exist when the
 * build constructs its steps — the outpost deploys later in the same build).
 */
function planSolanaNonNativeSteps<C extends ClusterBuildContext>(
  options: ClusterBuildStepOptions,
  account: string,
  chainName: string,
  tokenName: string,
  chainCode: bigint,
  tokenCode: bigint,
  amount: bigint
): ClusterBuildStep.Any<C>[] {
  return [
    SolanaFundingTool.planAirdrop<C>(
      Report.Actor.Underwriter,
      `${account}-${chainName}-airdrop`,
      `fund ${account} SOL keypair for the ${tokenName} deposit`,
      options,
      account,
      amount + WireUnderwriterTool.SolAirdropHeadroomLamports
    ),
    SolanaFundingTool.planSplMint<C>(
      Report.Actor.Underwriter,
      `${account}-${tokenName}-mint`,
      `mint ${amount} mock ${tokenName} to ${account}`,
      options,
      account,
      tokenCode,
      amount
    ),
    SolanaCollateralTool.planNonNativeDeposit<C>(
      Report.Actor.Underwriter,
      `${account}-${chainName}-${tokenName}-deposit`,
      `deposit ${amount} ${tokenName} on ${chainName} (SPL)`,
      options,
      account,
      chainCode,
      tokenCode,
      WireUnderwriterTool.PrimaryReserveCode,
      OperatorType.UNDERWRITER,
      amount
    )
  ]
}

