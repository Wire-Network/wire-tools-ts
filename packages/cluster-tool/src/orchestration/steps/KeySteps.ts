import Assert from "node:assert"
import { ethers } from "ethers"
import { range } from "lodash"
import { match } from "ts-pattern"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  SignatureProviderType,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import type { Tag } from "@aws-sdk/client-ssm"
import { eachSeries, mapSeries } from "../../utils/asyncUtils.js"
import { keyPairFromPrivate } from "../../utils/keyPairUtils.js"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { SSMClientProvider } from "../../config/SSMClientProvider.js"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import type { KeyPair } from "../../types/KeyPair.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { ClusterKeyStore } from "../outputs/ClusterKeyStore.js"
import { EthereumMnemonicKey } from "../outputs/EthereumMnemonicOutput.js"
import type { OperatorAccount } from "../outputs/OperatorAccount.js"
import type { StepInput } from "../StepRunner.js"
import { EthereumOutpostBootstrapper } from "../ethereum/EthereumOutpostBootstrapper.js"

const log = getLogger(__filename)

/** Steps that generate the cluster {@link ClusterKeyStore} + set up the kiod wallet. */
export namespace KeySteps {
  /**
   * Entropy behind a cluster-scoped Ethereum HD mnemonic — 32 bytes, i.e. the
   * 24-word BIP-39 form. Only an SSM cluster generates one (see
   * {@link EthereumMnemonicKey}).
   */
  export const EthereumMnemonicEntropyBytes = 32

  /**
   * SSM tag key recording which platform version a published key belongs to.
   * Its value is the cluster's `signatureProvider.ssm.version`; absent when the
   * cluster's SSM settings carry no version.
   */
  export const PlatformVersionTagKey = "wire:platform-version"

  /**
   * The Ethereum HD mnemonic PHRASE this run derives operator EM (secp256k1)
   * keys from: the cluster-scoped one {@link runGenerateNodeKeys} put in
   * `ctx.outputs` under SSM, else the published
   * `EthereumOutpostBootstrapper.AnvilMnemonic`.
   *
   * The anvil mnemonic is a PUBLISHED constant, so under it every operator's
   * ETH collateral key is reproducible by anyone with the repo — acceptable for
   * a local flow cluster (and required, so all 13 flows keep deriving
   * byte-identical wallets), never for a real deployment. Read through this
   * accessor, never off `EthereumOutpostBootstrapper` directly.
   *
   * @param ctx - The build context.
   * @returns The mnemonic phrase to derive EM keys from.
   */
  export function ethereumMnemonic(ctx: ClusterBuildContext): string {
    return (
      ctx.outputs.get(EthereumMnemonicKey) ??
      EthereumOutpostBootstrapper.AnvilMnemonic
    )
  }

  /** A freshly generated cluster-scoped Ethereum HD mnemonic phrase. */
  function newEthereumMnemonic(): string {
    return ethers.Mnemonic.fromEntropy(
      ethers.randomBytes(EthereumMnemonicEntropyBytes)
    ).phrase
  }

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
    // The cluster-scoped Ethereum mnemonic is minted HERE, before the first key
    // exists, because operator provisioning derives every EM key from it. It
    // rides `ctx.outputs` and NEVER `ClusterConfig` — the config ships inside
    // the release archives, which would make every operator EM private key
    // re-derivable from the deployable artifact.
    if (ctx.config.signatureProvider.type === SignatureProviderType.SSM) {
      ctx.outputs.set(EthereumMnemonicKey, newEthereumMnemonic())
    }
    const keyContext = KeyGenerator.context(
      ctx.config.executables.clio,
      ctx.config.buildPath,
      ethereumMnemonic(ctx)
    )
    // Producer NODE signing sets (K1+BLS per node), pushed into THE key store.
    // Operator identities (producer / batch / underwriter accounts) accumulate
    // into the same store per-label as their provisioning phases materialize
    // them — producers referencing their node's set from here.
    //
    // The nodes come from `NodeConfig.plan`, the SAME source
    // `signatureProviderKeyPublications` enumerates, so a node's secret-id
    // `{account}` segment here and at publish time can never drift.
    const nodes: ClusterKeyStore.NodeKeys[] = await mapSeries(
      producerNodes(ctx.config),
      async node => ({
        index: node.index,
        keys: await adoptOrCreateProducerKeySet(
          ctx.config,
          keyContext,
          node.name,
          `producer ${node.name} signing set`
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

  // ── D21 adopt-existing (the GENERATION seam) ───────────────────────────────

  /**
   * Obtain `account`'s `keyType` signing key: ADOPT the SSM parameter the AWS
   * account already owns, else GENERATE a new pair.
   *
   * D21 — an existing parameter is the account's DURABLE key identity and is
   * never regenerated. The read happens HERE, where key material is FIRST
   * created, and deliberately NOT at publication time: a producer node's keys
   * are imported into the kiod wallet and rendered into its `config.ini` right
   * after generation, and an operator's identity sets its ON-CHAIN authority
   * (`roa::newuser`) and both authex links, all long before its publish step
   * runs. Adopting at publish time would leave SSM holding key B while the
   * wallet, the chain authority, both links and the emitted external config all
   * held key A — silently, and only on the SECOND create in an account.
   *
   * Under a non-SSM provider there is nothing to adopt and this is exactly
   * `KeyGenerator.create`.
   *
   * @param config - The resolved cluster config.
   * @param keyType - The curve to obtain.
   * @param account - The key's DURABLE handle (the secret-id `{account}`).
   * @param keyContext - Binaries + mnemonic the generation backends require.
   * @param options - Per-curve generation extras (EM's HD index, the purpose).
   * @returns The adopted or generated pair.
   */
  export async function adoptOrCreateSignatureProviderKey<T extends KeyType>(
    config: ClusterConfig,
    keyType: T,
    account: string,
    keyContext: KeyGenerator.Context,
    options: KeyGenerator.CreateOptions = {}
  ): Promise<KeyPair<T>> {
    const secretId = signatureProviderSecretId(config, account, keyType)
    if (secretId != null) {
      const adopted = await SSMClientProvider.getParameterAcrossRegions(
        replicationRegions(config),
        secretId
      )
      if (adopted != null) {
        log.info(
          `[keys] adopting the existing ${KeyType[keyType]} key for ${account} from ${secretId} — NOT regenerating`
        )
        StepExtraRecorder.note(
          `adopted ${account}'s existing ${KeyType[keyType]} key from SSM`,
          { account, keyType: KeyType[keyType], secretId }
        )
        return keyPairFromPrivate(keyType, adopted)
      }
    }
    return KeyGenerator.create(keyType, keyContext, options)
  }

  /**
   * A producer node's composite K1 + BLS key set — each half adopted or
   * generated independently via {@link adoptOrCreateSignatureProviderKey},
   * since SSM custody is per-parameter (a rotation could legitimately leave one
   * curve published and the other not).
   *
   * @param config - The resolved cluster config.
   * @param keyContext - Binaries + mnemonic the generation backends require.
   * @param nodeName - The node's name (the secret-id `{account}` segment).
   * @param purpose - What the set is FOR (lands in the step's `extra` record).
   * @returns The node's signing set.
   */
  export async function adoptOrCreateProducerKeySet(
    config: ClusterConfig,
    keyContext: KeyGenerator.Context,
    nodeName: string,
    purpose: string
  ): Promise<ClusterKeyStore.ProducerKeySet> {
    const [k1, bls] = await Promise.all([
      adoptOrCreateSignatureProviderKey(config, KeyType.K1, nodeName, keyContext, {
        purpose: `${purpose} — block signing (K1)`
      }),
      adoptOrCreateSignatureProviderKey(config, KeyType.BLS, nodeName, keyContext, {
        purpose: `${purpose} — finalizer (BLS)`
      })
    ])
    return { k1, bls }
  }

  /**
   * The SSM secret id `account`'s `keyType` key is published under, or nothing
   * when the cluster is not SSM-custodied (there is nothing to adopt — the key
   * is always generated). Rendered through the SAME
   * `ClusterConfigProvider.signatureProviderSource` the daemon
   * `--signature-provider` args use, so the adopt read, the publish write and
   * the rendered spec can never disagree on an id.
   *
   * @param config - The resolved cluster config.
   * @param account - The key's DURABLE handle (the secret-id `{account}`).
   * @param keyType - The key's curve.
   * @returns The rendered secret id, or nothing under KEY / KIOD.
   */
  export function signatureProviderSecretId(
    config: ClusterConfig,
    account: string,
    keyType: KeyType
  ): string {
    if (config.signatureProvider.type !== SignatureProviderType.SSM) return null
    return ClusterConfigProvider.signatureProviderSource(config)(
      account,
      keyType
    ).awsSecretId
  }

  /**
   * Every AWS region an SSM cluster replicates its parameters to. `regions` on
   * `awsClusterNodeConfig` is the ONE author; `ssm.awsRegions` is derived from
   * it at resolve time and only fills in for a config that reached here without
   * going through `ClusterConfigProvider.resolve`.
   */
  function replicationRegions(config: ClusterConfig): string[] {
    const { ssm } = config.signatureProvider
    Assert.ok(
      ssm != null,
      "KeySteps: SSM signature provider requires ssm settings"
    )
    Assert.ok(
      config.awsClusterNodeConfig != null,
      "KeySteps: SSM signature provider requires awsClusterNodeConfig (the secret-id {cluster} source + the replication regions)"
    )
    const { regions } = config.awsClusterNodeConfig,
      { awsRegions = regions } = ssm
    return awsRegions
  }

  /** The planned PRODUCER nodes, whose names are the node keys' `{account}` segments. */
  function producerNodes(config: ClusterConfig): NodeConfig[] {
    return NodeConfig.plan(config).filter(
      node => node.role === NodeRole.producer
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
    /**
     * EVERY AWS region the parameter is published to. There is no primary
     * region: the key is replicated to all of them so a disaster-recovery
     * migration into any one finds it already present.
     */
    awsRegions: string[]
    /** The rendered SSM secret id (via `toSecretId`) — NEVER the private key. */
    secretId: string
    /**
     * The cluster's `{version}` token value — carried as the
     * {@link PlatformVersionTagKey} tag on the `PutParameter`. Absent when the
     * cluster's SSM settings declare no version.
     */
    version?: string
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
    const awsRegions = replicationRegions(config),
      { account: cluster } = config.awsClusterNodeConfig,
      { ssm } = config.signatureProvider,
      // The `{account}` pattern token renders the DURABLE LABEL — a producer
      // node's name, an operator's handle — never the on-chain account.
      renderSecretId = (label: string, keyType: KeyType): string =>
        ClusterConfigProvider.toSecretId(ssm.awsSecretIdPattern, {
          cluster,
          account: label,
          keyType: KeyType[keyType],
          version: ssm.version
        }),
      publications: SignatureProviderKeyPublication[] = []
    // Producer-node signing keys (K1 + BLS per node).
    producerNodes(config).forEach(node =>
      ([KeyType.K1, KeyType.BLS] as const).forEach(keyType =>
        publications.push({
          source: SignatureKeySource.node,
          nodeIndex: node.index,
          label: node.name,
          keyType,
          awsRegions,
          secretId: renderSecretId(node.name, keyType),
          version: ssm.version
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
          awsRegions,
          secretId: renderSecretId(label, keyType),
          version: ssm.version
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
   *
   * The id is re-probed and written PER REGION, not once for the key: a key
   * ADOPTED out of `us-east-1` still has to be written to `eu-west-1`, or
   * replication silently breaks the moment a disaster-recovery migration
   * targets a region that never received it. The probe is also what lets the
   * write stay `Overwrite: false` — the alternative would rotate a live key out
   * from under every consumer already holding it.
   *
   * The step's input is built at COMPOSE time from config alone, before any key
   * exists, so it deliberately carries no "was this adopted?" flag — whether a
   * given region already holds the parameter is a RUNTIME fact this runner
   * discovers per region.
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
    const nativePrivateKey = PrivateKey.from(privateKey).toNativeString(),
      tags: Tag[] =
        input.version != null
          ? [{ Key: PlatformVersionTagKey, Value: input.version }]
          : []
    await eachSeries(input.awsRegions, async region => {
      const existing = await SSMClientProvider.tryGetParameter(
        region,
        input.secretId
      )
      if (existing != null) {
        log.info(
          `[keys] ${input.secretId} is already published in ${region} — retained (this run adopted it)`
        )
        return
      }
      await SSMClientProvider.putParameter(
        region,
        input.secretId,
        nativePrivateKey,
        tags
      )
    })
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
