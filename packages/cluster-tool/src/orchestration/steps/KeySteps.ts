import { mapSeries } from "../../utils/asyncUtils.js"
import { Constants } from "../../Constants.js"
import { range } from "lodash"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { ClusterKeyStore } from "../outputs/ClusterKeyStore.js"
import { EthereumOutpostBootstrapper } from "../ethereum/EthereumOutpostBootstrapper.js"

/** Steps that generate the cluster {@link ClusterKeyStore} + set up the kiod wallet. */
export namespace KeySteps {
  /**
   * Generate the cluster's key material — one K1+BLS set per producer node
   * (via `clio` / `sys-util`), one K1 + ED25519 per operator — and store it under
   * {@link ClusterKeyStoreKey} for downstream node-config, wallet, authex, and
   * registration steps.
   */
  export function planGenerateNodeKeys<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runGenerateNodeKeys
    )
  }

  /** Named runner — generate node + operator keys into `ctx.outputs`. */
  export async function runGenerateNodeKeys<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const keyContext = KeyGenerator.context(
      ctx.config.executables.clio,
      ctx.config.buildPath,
      EthereumOutpostBootstrapper.AnvilMnemonic
    )
    // Producer NODE signing sets (K1+BLS per node), pushed into THE key store.
    // Operator identities (producer / batch / underwriter accounts) accumulate
    // into the same store per-account as their provisioning phases materialize
    // them — producers referencing their node's set from here.
    const nodes: ClusterKeyStore.NodeKeys[] = await mapSeries(
      range(ctx.config.nodeCount),
      async index => ({
        index,
        keys: await KeyGenerator.createProducerKeySet(
          keyContext,
          `producer node_${String(index).padStart(2, "0")} signing set`
        )
      })
    )
    ctx.keyStore.pushNodes(...nodes)
  }

  /**
   * Open the kiod wallet and import every key needed for the run: the BIOS dev
   * K1 + BLS keys plus every generated node K1/BLS and operator K1. Requires
   * {@link planGenerateNodeKeys} to have run first.
   */
  export function planCreateWallet<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runCreateWallet
    )
  }

  /** Named runner — `wallet.getOrCreate()` then import the BIOS + generated keys. */
  export async function runCreateWallet<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const wallet = await ctx.wire.wallet.getOrCreate(),
      nodeKeys = ctx.keyStore.nodes.flatMap(node => [
        node.keys.k1.privateKey,
        node.keys.bls.privateKey
      ])
    // BIOS dev keys + the generated producer node keys. Each batch/underwriter
    // operator's UNIQUE wire key is imported by its own materialize step.
    await wallet.addPrivateKey(
      Constants.DEV_K1_PRIVATE_KEY,
      Constants.DEV_BLS_PRIVATE_KEY,
      ...nodeKeys
    )
  }
}
