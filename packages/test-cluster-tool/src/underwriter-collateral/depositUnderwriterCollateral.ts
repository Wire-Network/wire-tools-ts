import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair } from "@solana/web3.js"
import { ethers } from "ethers"
import Bluebird from "bluebird"

import { ChainKind, OperatorType, TokenKind } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import type { UnderwriterCollateralEntry } from "@wireio/debugging-shared"

import { ETHBootstrapper } from "../cluster/ETHBootstrapper.js"
import { log } from "../logger.js"
import { depositETHCollateral } from "../tools/ETHCollateralTool.js"
import { depositSOLCollateral } from "../tools/SOLCollateralTool.js"

/**
 * Per-underwriter context the deposit step needs in order to dispatch
 * to the right signer / connection / contract on each chain.
 *
 * The harness builds this struct in `ClusterManager` (which already
 * has every input on hand) and hands it to
 * {@link depositUnderwriterCollateral}; the helper itself stays
 * agnostic about how the underwriter accounts / keys were materialised.
 */
export interface UnderwriterDepositContext {
  /** WIRE account name, e.g. `uwrit.a`. */
  account: string
  /**
   * HD-derivation index into the anvil mnemonic. Selects the
   * underwriter's ETH wallet — must match the index used by
   * `linkOperatorChainAccounts` so the depot resolves the deposit's
   * `from` address to this WIRE account via authex.
   */
  ethHdIndex: number
  /**
   * SOL keypair the underwriter signs with. Must match the key linked
   * via authex on the same account; otherwise the depot would resolve
   * the SOL fee-payer to a different (or no) WIRE account.
   */
  solPrivateKey: PrivateKey
}

/** Options bag passed to {@link depositUnderwriterCollateral}. */
export interface DepositUnderwriterCollateralOptions {
  /** Path to the wire-ethereum repo root (resolves ABI + addresses). */
  ethereumPath: string
  /** Path to the wire-solana repo root (resolves opp_outpost IDL). */
  solanaPath?: string
  /** Anvil RPC URL (default: `http://127.0.0.1:8545`). */
  anvilRpcUrl: string
  /** Solana RPC URL (default: `http://127.0.0.1:8899`). */
  solanaRpcUrl: string
  /**
   * Per-underwriter collateral plan from
   * `ClusterConfig.underwriterCollateral`. Length must match
   * `underwriters.length`.
   */
  collateral: UnderwriterCollateralEntry[][]
  /** Per-underwriter deposit context (account + ETH HD index + SOL key). */
  underwriters: UnderwriterDepositContext[]
}

/**
 * Submit collateral deposits for every underwriter per the resolved
 * `ClusterConfig.underwriterCollateral` plan. Dispatches per-chain to
 * the existing chain-specific helpers
 * ({@link depositETHCollateral}, {@link depositSOLCollateral});
 * does NOT wait for the OPP envelope to settle on the depot — the
 * deposits land asynchronously when batch operators ferry the
 * `OPERATOR_ACTION(DEPOSIT_REQUEST)` attestation back. Tests that need
 * a guaranteed `OPERATOR_STATUS_ACTIVE` before proceeding poll the
 * depot's `sysio.opreg::operators` table themselves.
 *
 * WIRE/WIRE entries are intentionally skipped (with a `warn`) until a
 * WIRE-native underwriter collateral deposit path exists — the OPP
 * outpost surface is per-external-chain by construction and there is
 * no equivalent "outpost deposit" on the WIRE chain itself today.
 *
 * @param opts Resolved chain endpoints + plan + per-underwriter context.
 * @throws If `opts.collateral.length !== opts.underwriters.length`, or
 *   if any chain-specific deposit reverts / fails.
 */
export async function depositUnderwriterCollateral(
  opts: DepositUnderwriterCollateralOptions
): Promise<void> {
  Assert.ok(
    opts.collateral.length === opts.underwriters.length,
    `underwriter collateral plan length (${opts.collateral.length}) must equal ` +
      `underwriter count (${opts.underwriters.length})`
  )

  const ethProvider = new ethers.JsonRpcProvider(opts.anvilRpcUrl),
    anvilMnemonic = ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic),
    ethAddrs = loadEthAddresses(opts.ethereumPath),
    opRegAbi = loadEthAbi(opts.ethereumPath, "OperatorRegistry")

  // SOL setup is only built when an entry needs it; many test clusters run
  // ETH-only and we shouldn't spin up an Anchor provider for nothing.
  const solCtx = asSolanaContextLazy(opts)

  await Bluebird.mapSeries(
    opts.underwriters.entries(),
    async ([idx, uw]) => {
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
        ethers.SigningKey.computePublicKey(ethWallet.privateKey, /* compressed */ true)
      )

      await Bluebird.each(opts.collateral[idx], async entry => {
        const amount = BigInt(entry.amount)
        if (amount <= 0n) return

        if (entry.chain === ChainKind.ETHEREUM) {
          await depositETHCollateral(
            opRegContract,
            OperatorType.UNDERWRITER,
            compressedPubkey,
            entry.tokenKind,
            amount
          )
          log.info(
            `[uw-collateral] ${uw.account}: deposited ${entry.amount} ` +
              `${TokenKind[entry.tokenKind]} on ETH`
          )
          return
        }
        if (entry.chain === ChainKind.SOLANA) {
          const sol = await solCtx.get()
          const depositorKp = privateKeyToKeypair(uw.solPrivateKey)
          await depositSOLCollateral(
            sol.connection,
            sol.program,
            depositorKp,
            OperatorType.UNDERWRITER,
            entry.tokenKind,
            amount
          )
          log.info(
            `[uw-collateral] ${uw.account}: deposited ${entry.amount} ` +
              `${TokenKind[entry.tokenKind]} on SOL`
          )
          return
        }
        if (entry.chain === ChainKind.WIRE) {
          // WIRE collateral has no outpost-side deposit path today — the
          // OPP-attestation deposit credits live on external chains by
          // construction. Skip with a structured warn so the config
          // round-trips losslessly and a future WIRE deposit pathway can
          // be slotted in without touching every caller.
          log.warn(
            `[uw-collateral] ${uw.account}: skipping WIRE/${TokenKind[entry.tokenKind]} ` +
              `entry — no WIRE-native underwriter collateral deposit path yet`
          )
          return
        }
        log.warn(
          `[uw-collateral] ${uw.account}: skipping unsupported chain ` +
            `${ChainKind[entry.chain]}/${TokenKind[entry.tokenKind]}`
        )
      })
    }
  )
}

interface SolanaContext {
  connection: Connection
  program: anchor.Program<anchor.Idl>
}

/**
 * Lazy-init the Solana RPC + IDL-bound Anchor program. Costly enough
 * (Connection handshake + IDL JSON read) that ETH-only clusters
 * shouldn't pay for it; deferred until the first SOL deposit is
 * actually requested.
 */
function asSolanaContextLazy(
  opts: DepositUnderwriterCollateralOptions
): { get(): Promise<SolanaContext> } {
  let cached: SolanaContext | undefined
  return {
    async get(): Promise<SolanaContext> {
      if (cached) return cached
      Assert.ok(
        opts.solanaPath,
        "depositUnderwriterCollateral: SOL entry encountered but solanaPath unset"
      )
      const idlFile = Path.join(
        opts.solanaPath,
        "target",
        "idl",
        "opp_outpost.json"
      )
      Assert.ok(
        Fs.existsSync(idlFile),
        `depositUnderwriterCollateral: opp_outpost IDL not found at ${idlFile}`
      )
      const idl = JSON.parse(Fs.readFileSync(idlFile, "utf8")) as anchor.Idl
      const connection = new Connection(opts.solanaRpcUrl, "confirmed")
      // The Anchor provider needs a wallet to construct, but
      // `depositSOLCollateral` passes its own depositor keypair to the
      // signers list — the placeholder wallet is never used to sign.
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
 * Convert a `sdk-core` ED25519 `PrivateKey` to a Solana web3.js
 * `Keypair`. Mirrors the conversion the authex-link site uses (the
 * underlying 64-byte ED25519 expanded private key is the same shape
 * Solana's `Keypair.fromSecretKey` expects). Centralised here so the
 * deposit signer matches the authex-linked pubkey by construction.
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
    `depositUnderwriterCollateral: ETH addresses not found at ${addrsPath}`
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
    `depositUnderwriterCollateral: ETH artifact not found at ${artifactPath}`
  )
  return JSON.parse(Fs.readFileSync(artifactPath, "utf8")).abi
}
