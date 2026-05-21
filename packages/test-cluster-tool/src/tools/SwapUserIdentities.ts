/**
 * SwapUserIdentities — generic harness helper that provisions a paired
 * Ethereum + Solana user identity for swap E2E tests
 * (flow-swap-with-underwriting + flow-swap-non-native-tokens +
 * flow-swap-variance-revert).
 *
 * Why this is a separate concept from operator wallets:
 * - The harness's `buildEthereumOperatorWallets` / Solana operator
 *   keypair generators are bound to the bootstrap-time operator roster
 *   (batchop.\*, uwrit.\*, prod.\*). Reusing one of those keypairs for a
 *   user-initiated swap would conflate operator identity with end-user
 *   identity in the depot's authex resolution.
 * - Swap tests need a stable identity across `pollUntil` deadlines and
 *   across test files in the same package — the same ETH wallet must
 *   appear in `swapRequest.actor`, in the `SwapRemit.recipient` on the
 *   reverse direction, and in the `ethProvider.getBalance` assertion at
 *   the end. Persisting to `<clusterPath>/state/swap_user.json` makes
 *   the identity survive harness teardown and re-attach.
 *
 * On creation the helper:
 *   1. Allocates a high-index slot in the anvil mnemonic (past every
 *      bootstrapped operator) for the ETH wallet — same convention as
 *      `flow-batch-operator-termination`'s `FRESH_OP_HD_INDEX`.
 *   2. Generates a fresh Solana keypair.
 *   3. Airdrops the Solana keypair enough lamports to cover the swap
 *      source amount + a generous rent + tx-fee buffer.
 *   4. Persists `{ ethereumPath, solanaSecret }` to
 *      `<clusterPath>/state/swap_user.json`.
 *
 * Idempotent: subsequent calls read the persisted file and rehydrate
 * the same wallet + keypair (no fresh airdrop unless the SOL balance has
 * dropped below the configured floor).
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"
import { Keypair, LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js"
import type { FlowTestContext } from "../FlowTestContext.js"
import { SOLClient } from "../clients/SOLClient.js"
import { ETHBootstrapper } from "../cluster/ETHBootstrapper.js"
import { log } from "../logger.js"

/**
 * Paired user identities for a swap E2E test. Both halves are
 * persisted across cluster restarts so per-step balance assertions
 * compare against a stable baseline.
 */
export interface SwapUserIdentities {
  /**
   * Ethereum user wallet — derived from the anvil mnemonic at an HD
   * index past every bootstrap-allocated operator slot. Connected to
   * the harness's `ethProvider`.
   */
  ethereumWallet:        ethers.HDNodeWallet
  /**
   * Solana user keypair — generated fresh on first call. Airdropped
   * enough lamports for the swap source amount + rent + tx fees.
   */
  solanaKeypair:         Keypair
  /** Raw 20-byte EVM address for the Ethereum wallet (compact form). */
  ethereumAddressBytes:  Uint8Array
  /** Raw 32-byte ed25519 pubkey for the Solana keypair. */
  solanaPublicKeyBytes:  Uint8Array
}

/**
 * Options controlling identity provisioning. Sane defaults match the
 * shapes flow-swap-with-underwriting uses.
 */
export interface SwapUserIdentitiesOptions {
  /**
   * HD index for the Ethereum wallet. Must be past every operator
   * slot — the harness's `buildEthereumOperatorWallets` walks
   * `1..N+M+1` (batchops + underwriters + 1 fresh), so anything ≥ 32
   * is safely past the largest expected cluster shape.
   */
  ethereumHdIndex?: number
  /**
   * Lamport floor for the airdrop. The default 100 SOL covers
   * Phase B's 1042 SOL swap source amount (≈1.04 × 10^12 lamports)
   * with rent + tx-fee headroom, and the airdrop only re-fires when
   * the existing balance is below this floor.
   */
  solanaAirdropFloorLamports?: number
}

export namespace SwapUserIdentities {
  /** HD index past every operator slot in the largest planned cluster. */
  export const DefaultEthereumHdIndex = 32
  /** Airdrop floor — 100 SOL covers Phase B's swap source amount. */
  export const DefaultSolanaAirdropFloorLamports = 100 * LAMPORTS_PER_SOL
  /** Persisted-state filename under `<clusterPath>/state/`. */
  export const StateFilename = "swap_user.json"
  /** Deadline for the airdrop confirmation poll. */
  export const AirdropConfirmTimeoutMs = 60_000
  /** Sleep between airdrop confirmation polls. */
  export const AirdropConfirmPollIntervalMs = 500
}

/**
 * Idempotently provision a paired Ethereum + Solana identity.
 *
 * Subsequent calls read the persisted state file and rehydrate
 * the same wallet + keypair.
 */
export async function ensureSwapUserIdentities(
  context: FlowTestContext,
  options: SwapUserIdentitiesOptions = {}
): Promise<SwapUserIdentities> {
  const ethereumHdIndex =
    options.ethereumHdIndex ?? SwapUserIdentities.DefaultEthereumHdIndex
  const airdropFloor =
    options.solanaAirdropFloorLamports
      ?? SwapUserIdentities.DefaultSolanaAirdropFloorLamports

  const stateDir  = Path.join(context.clusterPath, "state")
  const stateFile = Path.join(stateDir, SwapUserIdentities.StateFilename)
  Fs.mkdirSync(stateDir, { recursive: true })

  const persisted = readPersistedIdentities(stateFile)
  const solanaKeypair = persisted?.solanaSecret
    ? Keypair.fromSecretKey(Uint8Array.from(persisted.solanaSecret))
    : Keypair.generate()

  if (!persisted) {
    Fs.writeFileSync(stateFile, JSON.stringify({
      ethereumHdIndex,
      solanaSecret: Array.from(solanaKeypair.secretKey)
    }, null, 2))
    log.info(
      `[SwapUserIdentities] provisioned new identities at ${stateFile}`
    )
  }

  Assert.ok(
    context.ethProvider,
    "ensureSwapUserIdentities: FlowTestContext.ethProvider must be available"
  )
  const ethereumWallet = ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic),
    `${ETHBootstrapper.DerivationPath}${ethereumHdIndex}`
  ).connect(context.ethProvider)

  await maybeAirdropSolana(context, solanaKeypair.publicKey, airdropFloor)

  return {
    ethereumWallet,
    solanaKeypair,
    ethereumAddressBytes: ethers.getBytes(ethereumWallet.address),
    solanaPublicKeyBytes: solanaKeypair.publicKey.toBytes()
  }
}

/**
 * Read + parse the persisted identity file. Returns `null` if missing
 * or malformed (parse failures fall back to a fresh provision rather
 * than tripping the harness).
 */
function readPersistedIdentities(
  stateFile: string
): { ethereumHdIndex: number; solanaSecret: number[] } | null {
  if (!Fs.existsSync(stateFile)) return null
  try {
    const raw = JSON.parse(Fs.readFileSync(stateFile, "utf-8"))
    if (
      typeof raw === "object" && raw !== null &&
      typeof raw.ethereumHdIndex === "number" &&
      Array.isArray(raw.solanaSecret) &&
      raw.solanaSecret.length === 64
    ) {
      return raw
    }
    log.warn(
      `[SwapUserIdentities] persisted file ${stateFile} has bad shape — regenerating`
    )
    return null
  } catch (err) {
    log.warn(
      `[SwapUserIdentities] persisted file ${stateFile} unreadable (${err}) — regenerating`
    )
    return null
  }
}

/**
 * Airdrop SOL to the user keypair when the current balance is below
 * `floorLamports`. No-op when already funded so re-running tests
 * doesn't pile up unbounded lamports on the user wallet.
 *
 * Uses `getSignatureStatus` polling rather than the WS-based
 * `confirmTransaction` — the latter is unreliable on the test
 * validator (the same reason SOLBootstrap switched away from it).
 */
async function maybeAirdropSolana(
  context: FlowTestContext,
  publicKey: PublicKey,
  floorLamports: number
): Promise<void> {
  const solanaRpcPort = context.ports.solanaRpc
  if (!solanaRpcPort) {
    log.info(
      "[SwapUserIdentities] solana port unset — skipping airdrop"
    )
    return
  }
  const solClient = new SOLClient(`http://127.0.0.1:${solanaRpcPort}`)
  const current = await solClient.getLamports(publicKey)
  if (current >= floorLamports) return
  const requestLamports = floorLamports - current + LAMPORTS_PER_SOL
  log.info(
    `[SwapUserIdentities] airdropping ${requestLamports} lamports to ${publicKey.toBase58()} (current=${current} floor=${floorLamports})`
  )
  const sig = await solClient.connection.requestAirdrop(publicKey, requestLamports)
  const deadline = Date.now() + SwapUserIdentities.AirdropConfirmTimeoutMs
  while (Date.now() < deadline) {
    const status = await solClient.connection.getSignatureStatus(sig)
    const conf = status?.value?.confirmationStatus
    if (conf === "confirmed" || conf === "finalized") return
    if (status?.value?.err) {
      throw new Error(
        `[SwapUserIdentities] airdrop tx failed: ${JSON.stringify(status.value.err)}`
      )
    }
    await new Promise(resolve => setTimeout(resolve, SwapUserIdentities.AirdropConfirmPollIntervalMs))
  }
  throw new Error(
    `[SwapUserIdentities] airdrop tx ${sig} not confirmed within ${SwapUserIdentities.AirdropConfirmTimeoutMs}ms`
  )
}
