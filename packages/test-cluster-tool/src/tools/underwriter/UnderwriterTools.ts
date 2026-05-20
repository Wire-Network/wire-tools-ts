/**
 * Underwriter-facing harness tools, grouped by concern. The
 * collateral cohort (defaults / load / deposit) is the only one
 * implemented today; future cohorts (race instrumentation, status
 * polling, etc.) will be sibling namespaces under
 * `UnderwriterTools` in the barrel.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair } from "@solana/web3.js"
import { ethers } from "ethers"
import Bluebird from "bluebird"

import {
  ChainKind,
  OperatorType,
  TokenAmount,
  TokenKind
} from "@wireio/opp-typescript-models"
import { SlugName, KeyType, PrivateKey } from "@wireio/sdk-core"
import type { ChainTokenAmount } from "@wireio/debugging-shared"

import { ETHBootstrapper } from "../../cluster/ETHBootstrapper.js"
import { log } from "../../logger.js"
import { depositETHCollateral } from "../ETHCollateralTool.js"
import { depositSOLCollateral } from "../SOLCollateralTool.js"

/**
 * Underwriter collateral surface — defaults, JSON config parsing,
 * and per-outpost deposit submission. Grouped together (rather than
 * three sibling files) because every entry point operates on the
 * same `ChainTokenAmount[][]` shape and lives under the same
 * conceptual concern: "what bond should each underwriter post, and
 * how does the harness apply that plan?".
 */
export namespace CollateralTools {
  // ── Defaults ────────────────────────────────────────────────────────────

  /**
   * Default per-(chain, token) deposit amount when neither
   * `--underwriter-collateral-json-file` nor a programmatic override
   * is provided. The spec at "Underwriter Collateral Config for
   * `test-cluster-tool`" calls for `1000` of each token, but the
   * underlying chains have widely-varying smallest-unit conventions:
   * 1000 lamports on Solana sits below the rent-exempt threshold the
   * `opp_outpost::deposit` ix triggers when it resizes the
   * operator-registry PDA, so a literal-1000 default fails at
   * simulation time. The value here (`1_000_000` base units)
   * matches flow-e's batch-operator deposit
   * (`FLOW_E_REQ_SOL_MIN_BOND`) and is the smallest amount
   * empirically known to clear PDA rent growth on Solana while
   * remaining negligible on Ethereum (1M wei = 10⁻¹² ETH) and on
   * WIRE.
   *
   * Encoded as `bigint` to match the `TokenAmount.amount` proto
   * field (`@protobuf-ts/runtime` decodes `int64` as `bigint`).
   * Operators that need realistic magnitudes set
   * `--underwriter-collateral-json-file` with explicit per-leg
   * amounts.
   */
  export const DefaultAmount: bigint = 1_000_000n

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

  // ── JSON config parsing ─────────────────────────────────────────────────

  /**
   * Parse a JSON value (already loaded from disk) into the canonical
   * length-`underwriterCount` per-underwriter shape stored on
   * `ClusterConfig.underwriterCollateral`. The input value may be
   * in either of two shapes per the spec at "Underwriter Collateral
   * Config for `test-cluster-tool`":
   *
   *   * **Uniform** — `Array<ChainTokenAmount>`. Applied to every
   *     underwriter. Fan-out-expanded to `underwriterCount` copies.
   *   * **Varied** — `Array<Array<ChainTokenAmount>>`. Outer array
   *     length MUST equal `underwriterCount`; otherwise this
   *     throws.
   *
   * Both shapes are parsed via `@protobuf-ts/runtime` JSON serdes
   * against the proto-generated `ChainTokenAmount` model, so
   * callers get full field-level validation (unknown fields →
   * error, missing required enum → error) without the harness
   * re-implementing the schema. The output preserves the hydrated
   * proto-message instances — `chain.kind` is the typed `ChainKind`
   * enum, `amount.kind` is the typed `TokenKind` enum, and
   * `amount.amount` is a `bigint`.
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
   *                          When `undefined`, defaults are used.
   * @param underwriterCount  Number of underwriters in the cluster.
   * @returns Length-`underwriterCount` array, one entry-list per
   *   underwriter.
   * @example
   *   // No file → defaults (DefaultAmount base units of
   *   // WIRE/ETH/SOL per underwriter).
   *   CollateralTools.load(undefined, 3)
   *   // With file → parsed per the file's shape (uniform or varied).
   *   CollateralTools.load("/path/to/file.json", 3)
   */
  export function load(
    filePath: string | undefined,
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

  // ── Per-outpost deposit submission ──────────────────────────────────────

  /**
   * Per-underwriter context the deposit step needs in order to
   * dispatch to the right signer / connection / contract on each
   * chain.
   *
   * The harness builds this struct in `ClusterManager` (which
   * already has every input on hand) and hands it to
   * {@link deposit}; the helper itself stays agnostic about how the
   * underwriter accounts / keys were materialised.
   */
  export interface DepositContext {
    /** WIRE account name, e.g. `uwrit.a`. */
    account: string
    /**
     * HD-derivation index into the anvil mnemonic. Selects the
     * underwriter's ETH wallet — must match the index used by
     * `linkOperatorChainAccounts` so the depot resolves the
     * deposit's `from` address to this WIRE account via authex.
     */
    ethHdIndex: number
    /**
     * SOL keypair the underwriter signs with. Must match the key
     * linked via authex on the same account; otherwise the depot
     * would resolve the SOL fee-payer to a different (or no) WIRE
     * account.
     */
    solPrivateKey: PrivateKey
  }

  /** Options bag passed to {@link deposit}. */
  export interface DepositOptions {
    /** Path to the wire-ethereum repo root (resolves ABI + addresses). */
    ethereumPath: string
    /** Path to the wire-solana repo root (resolves opp_outpost IDL). */
    solanaPath?: string
    /** Anvil RPC URL. */
    anvilRpcUrl: string
    /** Solana RPC URL. */
    solanaRpcUrl: string
    /**
     * Per-underwriter collateral plan from
     * `ClusterConfig.underwriterCollateral`. Length must match
     * `underwriters.length`. Each inner entry is a harness-local
     * {@link ChainTokenAmount} — `entry.chain_code` is a slug_name
     * (uint64 packed) and `entry.amount` is a proto `TokenAmount`
     * (`amount.tokenCode` is a slug_name `bigint`, `amount.amount` is
     * a `bigint`).
     */
    collateral: ChainTokenAmount[][]
    /** Per-underwriter deposit context (account + ETH HD index + SOL key). */
    underwriters: DepositContext[]
  }

  /**
   * Submit collateral deposits for every underwriter per the
   * resolved `ClusterConfig.underwriterCollateral` plan. Dispatches
   * per-chain to the existing chain-specific helpers
   * ({@link depositETHCollateral}, {@link depositSOLCollateral});
   * does NOT wait for the OPP envelope to settle on the depot —
   * the deposits land asynchronously when batch operators ferry
   * the `OPERATOR_ACTION(DEPOSIT_REQUEST)` attestation back. Tests
   * that need a guaranteed `OPERATOR_STATUS_ACTIVE` before
   * proceeding poll the depot's `sysio.opreg::operators` table
   * themselves.
   *
   * WIRE/WIRE entries are intentionally skipped (with a `warn`)
   * until a WIRE-native underwriter collateral deposit path
   * exists — the OPP outpost surface is per-external-chain by
   * construction and there is no equivalent "outpost deposit" on
   * the WIRE chain itself today.
   *
   * @param opts Resolved chain endpoints + plan + per-underwriter
   *   context.
   * @throws If `opts.collateral.length !== opts.underwriters.length`,
   *   or if any chain-specific deposit reverts / fails.
   */
  export async function deposit(opts: DepositOptions): Promise<void> {
    Assert.ok(
      opts.collateral.length === opts.underwriters.length,
      `underwriter collateral plan length (${opts.collateral.length}) must equal ` +
        `underwriter count (${opts.underwriters.length})`
    )

    const ethProvider = new ethers.JsonRpcProvider(opts.anvilRpcUrl),
      anvilMnemonic = ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic),
      ethAddrs = loadEthAddresses(opts.ethereumPath),
      opRegAbi = loadEthAbi(opts.ethereumPath, "OperatorRegistry")

    // SOL setup is only built when an entry needs it; many test clusters
    // run ETH-only and we shouldn't spin up an Anchor provider for nothing.
    const solCtx = asSolanaContextLazy(opts)

    await Bluebird.mapSeries(opts.underwriters.entries(), async ([idx, uw]) => {
      const ethWallet = ethers.HDNodeWallet.fromMnemonic(
        anvilMnemonic,
        `${ETHBootstrapper.DerivationPath}${uw.ethHdIndex}`
      ).connect(ethProvider)
      // `ethers.Contract` exposes ABI-declared methods dynamically;
      // structurally cast to the deposit interface the helper expects.
      const opRegContract = new ethers.Contract(
        ethAddrs.OperatorRegistry,
        opRegAbi,
        ethWallet
      ) as unknown as Parameters<typeof depositETHCollateral>[0]
      const compressedPubkey = ethers.getBytes(
        ethers.SigningKey.computePublicKey(
          ethWallet.privateKey,
          /* compressed */ true
        )
      )

      await Bluebird.each(opts.collateral[idx], async entry => {
        Assert.ok(entry.amount, "ChainTokenAmount.amount is required")
        const chainName = SlugName.toString(entry.chain_code),
          tokenCode = BigInt(Number(entry.amount.tokenCode)),
          tokenName = SlugName.toString(Number(entry.amount.tokenCode)),
          chainKind = chainKindForCodename(entry.chain_code),
          tokenKind = tokenKindForCodename(Number(entry.amount.tokenCode)),
          amount = entry.amount.amount
        if (amount <= 0n) return

        if (chainKind === ChainKind.EVM) {
          await depositETHCollateral(
            opRegContract,
            OperatorType.UNDERWRITER,
            compressedPubkey,
            tokenCode,
            amount
          )
          log.info(
            `[uw-collateral] ${uw.account}: deposited ${amount} ` +
              `${tokenName} on ${chainName}`
          )
          return
        }
        if (chainKind === ChainKind.SVM) {
          const sol = await solCtx.get()
          const depositorKp = privateKeyToKeypair(uw.solPrivateKey)
          // Underwriter SOL keypairs are generated fresh in
          // `ClusterManager.bootstrap`; the test-validator's genesis
          // pre-funds only the bootstrap fee-payer, so we airdrop
          // enough lamports here to cover the deposit + tx fees +
          // rent headroom before submitting. Mirrors flow-e's
          // batch-op deposit pattern.
          await ensureSolFunded(sol.connection, depositorKp, amount)
          try {
            await depositSOLCollateral(
              sol.connection,
              sol.program,
              depositorKp,
              OperatorType.UNDERWRITER,
              tokenCode,
              amount
            )
            log.info(
              `[uw-collateral] ${uw.account}: deposited ${amount} ` +
                `${tokenName} on ${chainName}`
            )
          } catch (err) {
            // Treat a timeout-on-confirm as best-effort: the tx may
            // have already landed (the opp-outpost program logs
            // success before this signature ever appears in the
            // validator's status cache, especially on a
            // freshly-restarted test-validator with cold indices).
            // The deposit is an OPP attestation that will be
            // credited on the depot asynchronously regardless of
            // whether this confirm poll saw the signature, so we
            // log + continue rather than tearing the whole start()
            // down. Non-timeout errors still propagate.
            const msg = (err as Error)?.message ?? String(err)
            if (msg.includes("not confirmed within")) {
              log.warn(
                `[uw-collateral] ${uw.account}: SOL deposit confirm timed out — ` +
                  `tx likely landed (validator may be cold-starting). ` +
                  `Continuing; depot will credit on next envelope.`
              )
            } else {
              throw err
            }
          }
          return
        }
        if (chainKind === ChainKind.WIRE) {
          // WIRE collateral has no outpost-side deposit path today.
          // The OPP-attestation deposit credits live on external
          // chains by construction. Skip with a structured warn so
          // the config round-trips losslessly and a future
          // WIRE-native pathway can slot in without touching every
          // caller.
          log.warn(
            `[uw-collateral] ${uw.account}: skipping WIRE/${tokenName} ` +
              `entry — no WIRE-native underwriter collateral deposit path yet`
          )
          return
        }
        log.warn(
          `[uw-collateral] ${uw.account}: skipping unsupported chain ` +
            `${chainName}/${tokenName}`
        )
      })
    })
  }
}

// ── Module-internal plumbing (NOT exported from the namespace) ────────────

/**
 * Bootstrap-time slug_name ↔ enum routing tables. The on-chain data model uses
 * `slug_name` (uint64 packed) for chain and token primary keys; the harness
 * still has to dispatch to per-chain outpost deposit helpers and pass the
 * appropriate `ChainKind` / `TokenKind` enum value to outpost-side contract
 * code (which is being migrated separately). These maps cover the bootstrap
 * set; if/when more outposts come online, extend with the matching entries.
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
  [SlugName.from("LIQSOL"), TokenKind.LIQ]
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

interface SolanaContext {
  connection: Connection
  program: anchor.Program<anchor.Idl>
}

/**
 * Lazy-init the Solana RPC + IDL-bound Anchor program. Costly
 * enough (Connection handshake + IDL JSON read) that ETH-only
 * clusters shouldn't pay for it; deferred until the first SOL
 * deposit is actually requested.
 */
function asSolanaContextLazy(opts: CollateralTools.DepositOptions): {
  get(): Promise<SolanaContext>
} {
  let cached: SolanaContext | undefined
  return {
    async get(): Promise<SolanaContext> {
      if (cached) return cached
      Assert.ok(
        opts.solanaPath,
        "CollateralTools.deposit: SOL entry encountered but solanaPath unset"
      )
      const idlFile = Path.join(
        opts.solanaPath,
        "target",
        "idl",
        "opp_outpost.json"
      )
      Assert.ok(
        Fs.existsSync(idlFile),
        `CollateralTools.deposit: opp_outpost IDL not found at ${idlFile}`
      )
      const idl = JSON.parse(Fs.readFileSync(idlFile, "utf8")) as anchor.Idl
      const connection = new Connection(opts.solanaRpcUrl, "confirmed")
      // The Anchor provider needs a wallet to construct, but
      // `depositSOLCollateral` passes its own depositor keypair to
      // the signers list — the placeholder wallet never signs.
      const placeholder = Keypair.generate()
      const provider = new anchor.AnchorProvider(
        connection,
        new anchor.Wallet(placeholder),
        { commitment: "confirmed" }
      )
      cached = { connection, program: new anchor.Program(idl, provider) }
      return cached
    }
  }
}

/**
 * Lamport airdrop floor — sized to cover several tx fees + the
 * deposit + a comfortable rent headroom for any PDA the deposit ix
 * touches. Matches the magnitude flow-e's batch-op deposit airdrop
 * uses (`5_000_000_000`); generous enough that test runs never stall
 * on under-funded operator wallets.
 */
const SolAirdropLamports = 5_000_000_000n

/** Max wall-clock to wait for `requestAirdrop` to confirm. */
const SolAirdropTimeoutMs = 30_000

/** Poll interval while waiting for an airdrop signature to confirm. */
const SolAirdropPollMs = 500

/**
 * Top the depositor's lamport balance up to {@link SolAirdropLamports}
 * if it currently sits below `depositAmount + SolAirdropLamports`.
 * Idempotent — a wallet that's already funded above the floor
 * short-circuits without an RPC call to `requestAirdrop`.
 */
async function ensureSolFunded(
  connection: Connection,
  depositor: Keypair,
  depositAmount: bigint
): Promise<void> {
  const current = BigInt(await connection.getBalance(depositor.publicKey)),
    floor = depositAmount + SolAirdropLamports
  if (current >= floor) return

  const sig = await connection.requestAirdrop(
    depositor.publicKey,
    Number(SolAirdropLamports)
  )
  const deadline = Date.now() + SolAirdropTimeoutMs
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(sig)
    const conf = status?.value?.confirmationStatus
    if (conf === "confirmed" || conf === "finalized") return
    if (status?.value?.err) {
      throw new Error(
        `CollateralTools.deposit: airdrop tx failed: ${JSON.stringify(
          status.value.err
        )}`
      )
    }
    await new Promise(resolve => setTimeout(resolve, SolAirdropPollMs))
  }
  throw new Error(
    `CollateralTools.deposit: airdrop signature ${sig} not confirmed within ${SolAirdropTimeoutMs}ms`
  )
}

/**
 * Convert a `sdk-core` ED25519 `PrivateKey` to a Solana web3.js
 * `Keypair`. Mirrors the conversion the authex-link site uses (the
 * underlying 64-byte ED25519 expanded private key is the same shape
 * Solana's `Keypair.fromSecretKey` expects).
 */
function privateKeyToKeypair(privateKey: PrivateKey): Keypair {
  Assert.ok(
    privateKey.type === KeyType.ED,
    `underwriter SOL private key must be ED25519, got ${privateKey.type}`
  )
  return Keypair.fromSecretKey(privateKey.data.array)
}

/** Load deployed ETH contract addresses from the wire-ethereum repo. */
function loadEthAddresses(ethereumPath: string): Record<string, string> {
  const addrsPath = Path.join(
    ethereumPath,
    ".local/deployments/outpost-addrs.json"
  )
  Assert.ok(
    Fs.existsSync(addrsPath),
    `CollateralTools.deposit: ETH addresses not found at ${addrsPath}`
  )
  return JSON.parse(Fs.readFileSync(addrsPath, "utf8"))
}

/** Load a Hardhat-built ABI for an outpost contract by name. */
function loadEthAbi(ethereumPath: string, name: string): ethers.InterfaceAbi {
  const artifactPath = Path.join(
    ethereumPath,
    "artifacts/contracts/outpost",
    `${name}.sol`,
    `${name}.json`
  )
  Assert.ok(
    Fs.existsSync(artifactPath),
    `CollateralTools.deposit: ETH artifact not found at ${artifactPath}`
  )
  return JSON.parse(Fs.readFileSync(artifactPath, "utf8")).abi
}
