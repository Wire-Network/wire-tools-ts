import {
  ClusterConfigProvider,
  EthereumFundingTool,
  EthereumWallet,
  KeyGenerator,
  SolanaFundingTool,
  WireLcoExportTool,
  eachSeries,
  type ClusterBuildOptions,
  type EthereumKeyPair
} from "@wireio/cluster-tool"
import { ChainKind } from "@wireio/opp-typescript-models"
import { LcoImportScenarioConstants as Constants } from "./LcoImportScenarioConstants.js"

/**
 * The flow's PRE-BOOTSTRAP stage (`FlowScenario.prepare`): every holder's random key —
 * generated through the `KeyGenerator` facade and persisted under the holder's durable
 * handle, exactly as the harness persists its own local-chain actors — and the two exports
 * the bootstrap imports, written by `WireLcoExportTool` from the committed templates with
 * each holder's persisted key in place of the template's placeholder. Nothing here contacts
 * a chain: it runs before the cluster is composed. Every later Step reads an identity back
 * by its handle.
 */
export namespace LcoImportScenarioExports {
  /**
   * The cluster data directory `clusterPath` resolves to — `ClusterConfigProvider.resolve`'s
   * own derivation, so what this stage persists is what `ctx.config.dataPath` finds later.
   *
   * @param clusterPath - The cluster directory.
   * @returns The cluster data directory.
   */
  export function dataPath(
    clusterPath: ClusterBuildOptions["clusterPath"]
  ): string {
    return ClusterConfigProvider.dataPath(clusterPath)
  }

  /**
   * Get-or-create an Ethereum holder's wallet under its handle: a random pair from the
   * `KeyGenerator` facade, persisted once. A handle already holding a wallet is read back
   * verbatim, so a re-run keeps the identity its exports name.
   *
   * @param dataPath - The cluster data directory.
   * @param context - The key-generation tooling.
   * @param holder - The Ethereum holder.
   * @returns The holder's persisted pair.
   */
  export async function createEthereumHolderWallet(
    dataPath: string,
    context: KeyGenerator.Context,
    holder: Constants.EthereumHolder
  ): Promise<EthereumKeyPair> {
    return EthereumFundingTool.createWallet(
      dataPath,
      holder.walletName,
      context,
      `flow-lco-import — ${holder.account}'s Ethereum holder wallet`
    )
  }

  /**
   * Get-or-create every holder's key: each Ethereum holder's wallet and each Solana holder's
   * keypair (`SolanaFundingTool.createKeypair`, idempotent by handle).
   *
   * @param dataPath - The cluster data directory.
   * @param buildPath - The wire-sysio build dir the key-generation tooling resolves from.
   */
  export async function createHolderKeys(
    dataPath: string,
    buildPath: ClusterBuildOptions["buildPath"]
  ): Promise<void> {
    const context = KeyGenerator.context(buildPath)
    await eachSeries(Constants.EthereumHolders, holder =>
      createEthereumHolderWallet(dataPath, context, holder)
    )
    Constants.SolanaHolders.forEach(holder =>
      SolanaFundingTool.createKeypair(dataPath, holder.keypairName)
    )
  }

  /**
   * An Ethereum holder's persisted identity: its compressed key and its address, both in the
   * export's lowercase `0x` form.
   *
   * @param dataPath - The cluster data directory.
   * @param holder - The Ethereum holder.
   * @returns The identity.
   */
  export function ethereumHolderIdentity(
    dataPath: string,
    holder: Constants.EthereumHolder
  ): WireLcoExportTool.HolderIdentity {
    return WireLcoExportTool.ethereumIdentity(
      EthereumWallet.loadKeyPair(dataPath, holder.walletName)
    )
  }

  /**
   * A Solana holder's persisted identity: its base58 key, which is also its address.
   *
   * @param dataPath - The cluster data directory.
   * @param holder - The Solana holder.
   * @returns The identity.
   */
  export function solanaHolderIdentity(
    dataPath: string,
    holder: Constants.SolanaHolder
  ): WireLcoExportTool.HolderIdentity {
    return WireLcoExportTool.solanaIdentity(
      SolanaFundingTool.loadKeypair(dataPath, holder.keypairName).publicKey.toBase58()
    )
  }

  /**
   * A holder's persisted identity, read back by its handle.
   *
   * @param dataPath - The cluster data directory.
   * @param holder - The holder.
   * @returns The identity.
   */
  export function holderIdentity(
    dataPath: string,
    holder: Constants.Holder
  ): WireLcoExportTool.HolderIdentity {
    // Two-variant union → one discriminant guard.
    return holder.chain === ChainKind.EVM
      ? ethereumHolderIdentity(dataPath, holder)
      : solanaHolderIdentity(dataPath, holder)
  }

  /**
   * Every holder as the placeholder → identity substitution the export tool applies: the
   * template address its rows carry, and the persisted key written in its place.
   *
   * @param dataPath - The cluster data directory.
   * @returns One substitution per holder, across both chains.
   */
  export function templateHolders(
    dataPath: string
  ): WireLcoExportTool.TemplateHolder[] {
    return Constants.Holders.map(holder => ({
      chain: holder.chain,
      templateAddress: holder.templateAddress,
      identity: holderIdentity(dataPath, holder)
    }))
  }

  /**
   * Write both exports under the cluster data directory from the committed templates, each
   * naming its holders' persisted keys, and return their paths.
   *
   * @param dataPath - The cluster data directory.
   * @returns The written exports.
   */
  export function writeExports(dataPath: string): WireLcoExportTool.ChainFiles {
    return WireLcoExportTool.writeExports(
      dataPath,
      Constants.Templates,
      templateHolders(dataPath)
    )
  }
}
