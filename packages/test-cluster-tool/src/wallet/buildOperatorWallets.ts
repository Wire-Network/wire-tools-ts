import Assert from "node:assert"
import { ethers } from "ethers"
import { match } from "ts-pattern"
import { PrivateKey } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  type NodeState,
  type OperatorNodeKeyMaterial
} from "@wireio/debugging-shared"
import { ETHBootstrapper } from "../cluster/ETHBootstrapper.js"
import type { OperatorAccountWallet } from "./OperatorAccountWallet.js"
import { EthereumOperatorAccountWallet } from "./EthereumOperatorAccountWallet.js"
import { SolanaOperatorAccountWallet } from "./SolanaOperatorAccountWallet.js"
import { WireOperatorAccountWallet } from "./WireOperatorAccountWallet.js"

/**
 * Shared input for every per-chain factory below — what the cluster
 * state knows about each operator role.
 */
export interface BuildOperatorWalletsArgs {
  /** Connected ETH provider (only used by the Ethereum factory). */
  ethProvider?: ethers.JsonRpcProvider
  /** Bootstrapped batch-operator nodes, in registration order. */
  batchOps: readonly NodeState[]
  /** Bootstrapped underwriter nodes, in registration order. */
  underwriters: readonly NodeState[]
  /** Which role's wallets to build. */
  type: OperatorType
}

/**
 * Select the `NodeState`s matching `type` and compute their HD slot
 * offsets in the anvil mnemonic (Phase 19a iterates
 * `[...batchOps, ...underwriters]` with `hdIndex = slotIndex + 1`).
 */
function selectNodeSlots(
  type: OperatorType,
  batchOps: readonly NodeState[],
  underwriters: readonly NodeState[]
): Array<{ ns: NodeState; slotIndex: number }> {
  return match(type)
    .with(OperatorType.BATCH, () =>
      batchOps.map((ns, i) => ({ ns, slotIndex: i }))
    )
    .with(OperatorType.UNDERWRITER, () =>
      underwriters.map((ns, i) => ({ ns, slotIndex: batchOps.length + i }))
    )
    .otherwise(() => {
      Assert.fail(
        `buildOperatorWallets: no bootstrapped wallets for type ${OperatorType[type]}`
      )
    })
}

/**
 * Pull the `keys` block off a `NodeState`, raising with a useful
 * message if the bootstrap didn't populate it (e.g., attached to a
 * cluster created before this field landed).
 */
function requireKeys(ns: NodeState): OperatorNodeKeyMaterial {
  Assert.ok(
    ns.keys,
    `buildOperatorWallets: NodeState for ${ns.operatorAccount ?? ns.nodeId} ` +
      "is missing `keys` — was this cluster bootstrapped before key " +
      "persistence landed? Recreate with a current build."
  )
  return ns.keys
}

/**
 * Build the Ethereum-chain operator wallets for `type`. The ETH
 * identity is deterministic from `ETHBootstrapper.AnvilMnemonic + HD
 * index`, so no per-operator state is read — `NodeState` is only used
 * to pick the operator's slot index and account name.
 */
export function buildEthereumOperatorWallets(
  args: BuildOperatorWalletsArgs
): OperatorAccountWallet[] {
  const { ethProvider, batchOps, underwriters, type } = args
  Assert.ok(
    ethProvider,
    "buildEthereumOperatorWallets: ethProvider is required"
  )
  const slots = selectNodeSlots(type, batchOps, underwriters)
  const mnemonic = ethers.Mnemonic.fromPhrase(ETHBootstrapper.AnvilMnemonic)
  return slots.map(({ ns, slotIndex }) => {
    Assert.ok(
      ns.operatorAccount,
      `buildEthereumOperatorWallets: node ${ns.nodeId} missing operatorAccount`
    )
    const hdIndex = slotIndex + 1
    const derived = ethers.HDNodeWallet.fromMnemonic(
      mnemonic,
      `${ETHBootstrapper.DerivationPath}${hdIndex}`
    )
    const ethWallet = derived.connect(ethProvider)
    return EthereumOperatorAccountWallet.fromEthersWallet({
      name: ns.operatorAccount,
      operatorType: type,
      ethWallet
    })
  })
}

/**
 * Build the Solana-chain operator wallets for `type`. Reads each
 * operator's persisted `keys.solEd` block — bootstrap writes this when
 * the cluster was created with a Solana outpost.
 */
export function buildSolanaOperatorWallets(
  args: BuildOperatorWalletsArgs
): OperatorAccountWallet[] {
  const { batchOps, underwriters, type } = args
  const slots = selectNodeSlots(type, batchOps, underwriters)
  return slots.flatMap(({ ns }) => {
    Assert.ok(
      ns.operatorAccount,
      `buildSolanaOperatorWallets: node ${ns.nodeId} missing operatorAccount`
    )
    const keys = requireKeys(ns)
    if (!keys.solEd) {
      // Underwriters and clusters without SOL outpost legitimately lack
      // a SOL key — skip so callers see a sparse but consistent array.
      return []
    }
    return [
      SolanaOperatorAccountWallet.fromSdkPrivateKey({
        name: ns.operatorAccount,
        operatorType: type,
        privateKey: PrivateKey.from(keys.solEd.privateKey)
      })
    ]
  })
}

/**
 * Build the WIRE-chain operator wallets for `type`. Reads each
 * operator's persisted `keys.wireK1` block (the K1 keypair imported
 * into kiod during bootstrap).
 */
export function buildWireOperatorWallets(
  args: BuildOperatorWalletsArgs
): OperatorAccountWallet[] {
  const { batchOps, underwriters, type } = args
  const slots = selectNodeSlots(type, batchOps, underwriters)
  return slots.map(({ ns }) => {
    Assert.ok(
      ns.operatorAccount,
      `buildWireOperatorWallets: node ${ns.nodeId} missing operatorAccount`
    )
    const keys = requireKeys(ns)
    Assert.ok(
      keys.wireK1,
      `buildWireOperatorWallets: ${ns.operatorAccount} missing wireK1 key material`
    )
    return WireOperatorAccountWallet.fromStrings({
      name: ns.operatorAccount,
      operatorType: type,
      publicKey: keys.wireK1.publicKey,
      privateKey: keys.wireK1.privateKey
    })
  })
}

