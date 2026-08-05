import Assert from "node:assert"
import Path from "node:path"
import { range } from "lodash"
import { match } from "ts-pattern"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { mapSeries } from "../../utils/asyncUtils.js"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { SSMClientProvider } from "../../config/SSMClientProvider.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { ClusterKeyStore } from "../outputs/ClusterKeyStore.js"
import type { OperatorAccount } from "../outputs/OperatorAccount.js"
import type { StepInput } from "../StepRunner.js"
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
    // into the same store per-label as their provisioning phases materialize
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

  // ── SSM key publication (create --signature-provider-type SSM) ─────────────

  /** Which store a published key is read back from. */
  export enum SignatureKeySource {
    node = "node",
    operator = "operator"
  }

  /** One signing key to publish to SSM — metadata ONLY (never key material). */
  export interface SignatureProviderKeyPublication {
    /** The store the runner reads the private key from. */
    source: SignatureKeySource
    /** Producer-node topology index (used when `source === node`). */
    nodeIndex: number
    /** The key's label (node name or operator label) — the secret-id `{account}`. */
    label: string
    /** The key's curve — selects which key of the source. */
    keyType: KeyType
    /** AWS region the parameter is published under. */
    awsRegion: string
    /** The rendered SSM secret id (via `toSecretId`) — NEVER the private key. */
    secretId: string
  }

  /** Typed input for {@link planPublishSignatureProviderKey}. */
  export interface PublishSignatureProviderKeyInput
    extends SignatureProviderKeyPublication,
      StepInput {
    /** Step-input discriminator. */
    kind: "KeySteps.PublishSignatureProviderKeyInput"
  }

  /**
   * Enumerate every generated signing key to publish for an SSM cluster —
   * plan-time fan-out from the config's counts: one entry per producer-node
   * K1/BLS and per batch/underwriter operator K1(wire)/EM(ethereum)/ED(solana).
   * The bios genesis key is a bootstrap dev key (not SSM-managed) and is
   * excluded. Each entry carries its pre-rendered `secretId` (never key
   * material); the runner reads the private key from `ctx.keyStore`.
   *
   * @param config - The resolved cluster config (SSM signature provider).
   * @returns The per-key publications.
   */
  export function signatureProviderKeyPublications(
    config: ClusterConfig
  ): SignatureProviderKeyPublication[] {
    const ssm = config.signatureProvider.ssm
    Assert.ok(
      ssm != null,
      "KeySteps.signatureProviderKeyPublications: SSM signature provider requires ssm settings"
    )
    const cluster = Path.basename(config.clusterPath),
      renderSecretId = (label: string, keyType: KeyType): string =>
        ClusterConfigProvider.toSecretId(ssm.awsSecretIdPattern, {
          cluster,
          account: label,
          keyType: KeyType[keyType]
        }),
      publications: SignatureProviderKeyPublication[] = []
    // Producer-node signing keys (K1 + BLS per node).
    NodeConfig.plan(config)
      .filter(node => node.role === NodeRole.producer)
      .forEach(node =>
        ([KeyType.K1, KeyType.BLS] as const).forEach(keyType =>
          publications.push({
            source: SignatureKeySource.node,
            nodeIndex: node.index,
            label: node.name,
            keyType,
            awsRegion: ssm.awsRegion,
            secretId: renderSecretId(node.name, keyType)
          })
        )
      )
    // Batch-operator + underwriter keys (K1 wire + EM ethereum + ED solana).
    const operatorLabels = [
      ...range(config.batchOperatorCount).map(index =>
        Constants.batchOperatorLabel(index)
      ),
      ...range(config.underwriterCount).map(index =>
        Constants.underwriterLabel(index)
      )
    ]
    operatorLabels.forEach(label =>
      ([KeyType.K1, KeyType.EM, KeyType.ED] as const).forEach(keyType =>
        publications.push({
          source: SignatureKeySource.operator,
          nodeIndex: 0,
          label,
          keyType,
          awsRegion: ssm.awsRegion,
          secretId: renderSecretId(label, keyType)
        })
      )
    )
    return publications
  }

  /**
   * Compose ONE publish phase for an SSM cluster — the `source`-class subset of
   * {@link signatureProviderKeyPublications}, one step per key, self-registered
   * on `parent`. `ClusterBuildDefaults` composes it at the point where the
   * source's keys EXIST but their SSM-fetching consumers have NOT started:
   * `node` keys right after `WalletAndKeys` (producer nodes fetch them from SSM
   * at startup), `operator` keys right after operator provisioning (the
   * operator daemons fetch theirs at startup). Publishing any later leaves the
   * consumer's `SSM:<region>:<secretId>` spec pointing at a parameter that does
   * not exist yet, aborting nodeop startup.
   *
   * @param parent - The build / group the phase self-registers on.
   * @param name - The phase name.
   * @param description - The phase description.
   * @param options - Step options applied to every publish step.
   * @param config - The resolved cluster config (SSM signature provider).
   * @param source - Which key-store class this phase publishes.
   * @returns The publish phase.
   */
  export function planSignatureProviderKeyPublications<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    config: ClusterConfig,
    source: SignatureKeySource
  ): ClusterBuildPhase<C> {
    const phase = ClusterBuildPhase.create<C>(parent, name, description)
    signatureProviderKeyPublications(config)
      .filter(publication => publication.source === source)
      .forEach(publication =>
        phase.push(
          planPublishSignatureProviderKey<C>(
            Report.Actor.Sysio,
            `publish-${publication.label}-${KeyType[publication.keyType]}`,
            `publish ${publication.label} ${KeyType[publication.keyType]} key → SSM`,
            options,
            publication
          )
        )
      )
    return phase
  }

  /**
   * Plan the publication of ONE generated signing key to AWS SSM.
   *
   * @param actor - The report actor.
   * @param name - The step name.
   * @param description - The step description.
   * @param options - Step options.
   * @param publication - The per-key publication descriptor (metadata only).
   * @returns The publish step.
   */
  export function planPublishSignatureProviderKey<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    publication: SignatureProviderKeyPublication
  ): ClusterBuildStep<C, PublishSignatureProviderKeyInput> {
    return ClusterBuildStep.create<C, PublishSignatureProviderKeyInput>(
      actor,
      name,
      description,
      options,
      { kind: "KeySteps.PublishSignatureProviderKeyInput", ...publication },
      runPublishSignatureProviderKey
    )
  }

  /**
   * Named runner — read the private key from `ctx.keyStore` and `PutParameter`
   * its CHAIN-NATIVE string (SecureString). The stored key is the WIRE
   * `PVT_<type>_…` form; the parameter value MUST be the native form
   * (`toNativeString()`: K1 WIF, EM 0x-hex, ED base58 of the 64-byte secret,
   * BLS `PVT_BLS_…`) — nodeop's ssm plugin parses the fetched value with the
   * per-chain NATIVE parser (`from_native_string_to_private_key`), the same
   * contract as the inline `KEY:` spec segment.
   */
  export async function runPublishSignatureProviderKey<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: PublishSignatureProviderKeyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const privateKey = match(input.source)
      .with(SignatureKeySource.node, () =>
        nodePrivateKey(ctx.keyStore.node(input.nodeIndex).keys, input.keyType)
      )
      .with(SignatureKeySource.operator, () =>
        operatorPrivateKey(
          ctx.keyStore.assertOperator(input.label),
          input.keyType
        )
      )
      .exhaustive()
    await SSMClientProvider.putParameter(
      input.awsRegion,
      input.secretId,
      PrivateKey.from(privateKey).toNativeString()
    )
  }

  /** The private key of a producer-node key set for `keyType` (K1 / BLS). */
  function nodePrivateKey(
    keys: ClusterKeyStore.ProducerKeySet,
    keyType: KeyType
  ): string {
    return match(keyType)
      .with(KeyType.K1, () => keys.k1.privateKey)
      .with(KeyType.BLS, () => keys.bls.privateKey)
      .otherwise(() => {
        throw new Error(`KeySteps: producer node has no ${KeyType[keyType]} key`)
      })
  }

  /** The private key of an operator for `keyType` (K1 wire / EM ethereum / ED solana). */
  function operatorPrivateKey(
    operator: OperatorAccount,
    keyType: KeyType
  ): string {
    return match(keyType)
      .with(KeyType.K1, () => operator.wire.privateKey)
      .with(KeyType.EM, () => {
        Assert.ok(
          operator.ethereum != null,
          `KeySteps: operator ${operator.label} has no ethereum key`
        )
        return operator.ethereum.privateKey
      })
      .with(KeyType.ED, () => {
        Assert.ok(
          operator.solana != null,
          `KeySteps: operator ${operator.label} has no solana key`
        )
        return operator.solana.privateKey
      })
      .otherwise(() => {
        throw new Error(`KeySteps: operator has no ${KeyType[keyType]} key`)
      })
  }
}
