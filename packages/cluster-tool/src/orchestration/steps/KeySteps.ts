import Assert from "node:assert"
import { Either } from "@3fv/prelude-ts"
import { ethers } from "ethers"
import { range } from "lodash"
import { match } from "ts-pattern"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import { NestedError } from "@wireio/shared"
import {
  SignatureProviderType,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import type { Tag } from "@aws-sdk/client-ssm"
import { eachSeries, mapSeries } from "../../utils/asyncUtils.js"
import {
  keyPairFromPrivate,
  privateKeyFromNativeString
} from "../../utils/keyPairUtils.js"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { SSMClientProvider } from "../../config/SSMClientProvider.js"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import type { KeyPair, SigningKeySet } from "../../types/KeyPair.js"
import { isNotEmpty } from "../../utils/predicateUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { ClusterKeyStore } from "../outputs/ClusterKeyStore.js"
import { EthereumMnemonicKey } from "../outputs/EthereumMnemonicOutput.js"
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

  /**
   * The {@link KeyGenerator.Context} every key-generation site in a run shares:
   * the cluster's `clio`, its build's `sys-util`, and the run's Ethereum
   * mnemonic ({@link ethereumMnemonic}). Resolved in ONE place so no site can
   * pair the wrong mnemonic with the right binaries.
   *
   * @param ctx - The build context.
   * @returns The generation context.
   */
  export function keyGeneratorContext(ctx: ClusterBuildContext): KeyGenerator.Context {
    return KeyGenerator.context(
      ctx.config.executables.clio,
      ctx.config.buildPath,
      ethereumMnemonic(ctx)
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
    const keyContext = keyGeneratorContext(ctx)
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
        node.keys.wire.privateKey,
        node.keys.wireFinalizer.privateKey
      ]),
      // The GENESIS identities, from the key store rather than the dev
      // constants. Under SSM `resolveWithBiosKeys` GENERATES these, and
      // `genesis.initial_key` carries the generated public half — so importing
      // `DEV_K1_PRIVATE_KEY` here left the wallet unable to sign as `sysio` for
      // every bootstrap action (setcode, feature activation, setprodkeys) or as
      // the node owner for `roa::newuser`. Under KEY/KIOD the seeded values ARE
      // the dev keys, so this is byte-identical there.
      genesisKeys = [NodeConfig.BiosName, Constants.BOOTSTRAP_NODE_OWNER]
        .map(label => ctx.keyStore.operator(label))
        .filter(identity => identity != null)
        .flatMap(identity =>
          [identity.wire?.privateKey, identity.wireFinalizer?.privateKey].filter(
            isNotEmpty
          )
        )
    // DEDUPED: `kiod` rejects a re-import with `key_exist_exception`, and the
    // genesis identities legitimately SHARE a key under KEY/KIOD —
    // `resolveWithBiosKeys` hands back the same dev pair for both the bios node
    // and the bootstrap node owner. Under SSM they are distinct generated keys,
    // so the set is a no-op there.
    //
    // Each batch/underwriter operator's UNIQUE wire key is imported by its own
    // materialize step.
    await wallet.addPrivateKey(...new Set([...genesisKeys, ...nodeKeys]))
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
    const [wire, wireFinalizer] = await Promise.all([
      adoptOrCreateSignatureProviderKey(config, KeyType.K1, nodeName, keyContext, {
        purpose: `${purpose} — block signing (K1)`
      }),
      adoptOrCreateSignatureProviderKey(config, KeyType.BLS, nodeName, keyContext, {
        purpose: `${purpose} — finalizer (BLS)`
      })
    ])
    return { wire, wireFinalizer }
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

  /**
   * WHEN a key is published, which is independent of WHERE it lives.
   *
   * Conflating the two is what made the bios failure possible: the genesis
   * identity's keys live in the operator map, but they must be in SSM before
   * the bios node starts — and the operator publish phase composes long after
   * it. `SignatureKeySource` answers "which keystore"; this answers "which
   * phase", and a row needs both.
   */
  export enum SignatureKeyPublishPhase {
    /** Before `BiosNode` — every key a nodeop fetches at startup. */
    beforeNodes = "beforeNodes",
    /** After operator provisioning — keys that do not exist until then. */
    afterOperators = "afterOperators"
  }

  /**
   * One identity whose keys are published to SSM — the walker's unit.
   *
   * `source` says only WHERE the identity's key set lives (the node list vs the
   * operator map); `label` is the secret-id `{account}` segment the daemon
   * renders. The two differ for the genesis identity, which is precisely the
   * case a single per-kind walker used to lose.
   */
  interface SignatureProviderKeyIdentity {
    /** Secret-id `{account}` segment — a node name or an operator handle. */
    label: string
    /** Which keystore holds the identity's key set. */
    source: SignatureKeySource
    /** Producer-node topology index (only meaningful when `source === node`). */
    nodeIndex: number
    /** Which publish phase this identity's keys belong to. */
    publishPhase: SignatureKeyPublishPhase
    /** Every curve this identity publishes. */
    keyTypes: readonly KeyType[]
  }

  /** One signing key to publish to SSM — metadata ONLY (never key material). */
  export interface SignatureProviderKeyPublication {
    /** The store the runner reads the private key from. */
    source: SignatureKeySource
    /** Producer-node topology index (used when `source === node`). */
    nodeIndex: number
    /** Which publish phase this key belongs to (independent of `source`). */
    publishPhase: SignatureKeyPublishPhase
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

  /** Renders ONE publication row — an identity's curve with its `secretId`, never key material. */
  type SignatureProviderKeyPublicationRenderer = (
    identity: SignatureProviderKeyIdentity,
    keyType: KeyType
  ) => SignatureProviderKeyPublication

  /**
   * The ONE renderer every publication row goes through, so a row composed by
   * the config walker and a row composed by a flow's provisioning phase can
   * never disagree on an id. The `{account}` pattern token renders the DURABLE
   * LABEL — a producer node's name, an operator's handle — never the on-chain
   * account.
   */
  function publicationRenderer(
    config: ClusterConfig
  ): SignatureProviderKeyPublicationRenderer {
    const awsRegions = replicationRegions(config),
      { account: cluster } = config.awsClusterNodeConfig,
      { ssm } = config.signatureProvider
    return (identity, keyType) => ({
      source: identity.source,
      nodeIndex: identity.nodeIndex,
      publishPhase: identity.publishPhase,
      label: identity.label,
      keyType,
      awsRegions,
      secretId: ClusterConfigProvider.toSecretId(ssm.awsSecretIdPattern, {
        cluster,
        account: identity.label,
        keyType: KeyType[keyType],
        version: ssm.version
      }),
      version: ssm.version
    })
  }

  /** The curves every OPP operator materializes: wire K1 + both outpost curves. */
  const OperatorKeyTypes = [KeyType.K1, KeyType.EM, KeyType.ED] as const
  /** A collateral-backed PRODUCER adds a finalizer key of its own. */
  const ProducerOperatorKeyTypes = [...OperatorKeyTypes, KeyType.BLS] as const

  /**
   * The curves an OPP operator's identity materializes and publishes, in
   * publication order: wire K1 + EM ethereum + ED solana for every operator,
   * plus BLS for a collateral-backed PRODUCER — it needs a finalizer key of its
   * own to hold a rank position at all, while batch operators and underwriters
   * have no finality role and get none. This is the set
   * `WireOperatorProvisioningTool.runIdentityMaterialization` materializes.
   *
   * @param type - The operator's proto type.
   * @returns The curves to publish.
   */
  export function operatorKeyTypes(type: OperatorType): readonly KeyType[] {
    return match(type)
      .with(OperatorType.PRODUCER, () => ProducerOperatorKeyTypes)
      .otherwise(() => OperatorKeyTypes)
  }

  /**
   * The walker's row for an OPP operator identity: published under its OWN
   * handle (it owns its generated keys), read from the operator map, and part
   * of the `afterOperators` phase (the keys do not exist until its
   * provisioning phase materializes them).
   */
  function operatorKeyIdentity(
    label: string,
    type: OperatorType
  ): SignatureProviderKeyIdentity {
    return {
      label,
      source: SignatureKeySource.operator,
      nodeIndex: 0,
      publishPhase: SignatureKeyPublishPhase.afterOperators,
      keyTypes: operatorKeyTypes(type)
    }
  }

  /**
   * The publications of ONE materialized OPP operator — one per curve of
   * {@link operatorKeyTypes}, under the operator's own handle. The bootstrap's
   * batch operators and underwriters ride exactly this shape inside
   * {@link signatureProviderKeyPublications}; a FLOW-provisioned operator,
   * whose label no config enumeration can know, is published through this
   * directly by its provisioning phase — the daemon it later starts renders
   * `SSM:` specs for these very ids.
   *
   * @param config - The resolved cluster config (SSM signature provider).
   * @param label - The operator's durable handle (the secret-id `{account}`).
   * @param type - The operator's proto type (selects the curves).
   * @returns The per-key publications.
   */
  export function operatorKeyPublications(
    config: ClusterConfig,
    label: string,
    type: OperatorType
  ): SignatureProviderKeyPublication[] {
    const render = publicationRenderer(config),
      identity = operatorKeyIdentity(label, type)
    return identity.keyTypes.map(keyType => render(identity, keyType))
  }

  /**
   * Whether the bootstrap's own publish phases cover `label` — true for every
   * identity {@link signatureProviderKeyPublications} enumerates from the
   * config (the genesis identity, producer nodes and accounts, the bootstrapped
   * batch operators and underwriters). A FLOW-provisioned operator is never in
   * that set, so its provisioning phase publishes its keys itself; the two
   * mechanisms therefore never plan the same parameter twice.
   *
   * @param config - The resolved cluster config (SSM signature provider).
   * @param label - The operator's durable handle.
   * @returns Whether the bootstrap publishes `label`'s keys.
   */
  export function isPublishedAtBootstrap(
    config: ClusterConfig,
    label: string
  ): boolean {
    return signatureProviderKeyPublications(config).some(
      publication => publication.label === label
    )
  }

  /**
   * Enumerate every generated signing key to publish for an SSM cluster —
   * plan-time fan-out over {@link SignatureProviderKeyIdentity} rows: the
   * genesis identity (bios K1/BLS) and the bootstrap node owner (K1), every
   * producer node (K1/BLS), and every batch/underwriter operator
   * (K1 wire / EM ethereum / ED solana).
   *
   * Under SSM the bios node is NOT exempt — it renders `SSM:` specs like any
   * other node, so its keys MUST be published or it cannot start. Each entry
   * carries its pre-rendered `secretId` (never key material); the runner reads
   * the private key from `ctx.keyStore`.
   *
   * @param config - The resolved cluster config (SSM signature provider).
   * @returns The per-key publications.
   */
  export function signatureProviderKeyPublications(
    config: ClusterConfig
  ): SignatureProviderKeyPublication[] {
    const render = publicationRenderer(config),
      // ONE enumeration of every identity that renders a `--signature-provider`
      // spec. Adding a row is the ONLY way to add a published key, so an
      // identity cannot be silently omitted the way the bios node was: it
      // renders `SSM:/…/node_bios/{K1,BLS}` from `node.name`, but the walker
      // enumerated producers only, so nothing ever wrote those parameters and
      // the bios daemon could not start on any SSM cluster.
      identities: SignatureProviderKeyIdentity[] = [
        // The genesis identity — bios block signing + finality. Its keys live in
        // the OPERATOR map (not `keyStore.nodes`, which `ConsensusSteps` turns
        // into the finalizer policy — a bios entry there would shift the
        // threshold), while its secret-id segment is the NODE name the daemon
        // renders. That split is exactly why it needs an explicit row.
        {
          label: NodeConfig.BiosName,
          source: SignatureKeySource.operator,
          nodeIndex: 0,
          publishPhase: SignatureKeyPublishPhase.beforeNodes,
          keyTypes: [KeyType.K1, KeyType.BLS]
        },
        // The bootstrap node owner — signs `roa::newuser` for every operator.
        {
          label: Constants.BOOTSTRAP_NODE_OWNER,
          source: SignatureKeySource.operator,
          nodeIndex: 0,
          publishPhase: SignatureKeyPublishPhase.beforeNodes,
          keyTypes: [KeyType.K1]
        },
        // Producer nodes — block signing + finality, keys in `keyStore.nodes`.
        //
        // NOTE: since finality moved to per-ACCOUNT finalizer keys, no nodeop fetches the
        // node-labelled BLS parameter and no finalizer policy names it. Dropping it would narrow
        // the custody surface, but the node/account publication split also decides which label
        // `buildArgs` resolves the BLOCK-SIGNING K1 from, and SSM startup is exercised only by the
        // cloud cluster workflow — so it is left in place pending a verification pass that can
        // actually observe an SSM boot. Tracked rather than changed blind.
        ...producerNodes(config).map(node => ({
          label: node.name,
          source: SignatureKeySource.node,
          nodeIndex: node.index,
          publishPhase: SignatureKeyPublishPhase.beforeNodes,
          keyTypes: [KeyType.K1, KeyType.BLS]
        })),
        // Producer ACCOUNTS — each owns a BLS finalizer key of its own, because `regfinkey`
        // enforces a global uniqueness check and siblings on one node would otherwise share
        // (and collide on) their node's key. The K1 they sign blocks with is still the node's,
        // republished here so every parameter this account's `--signature-provider` specs point
        // at holds exactly the key it names — the alternative, publishing the account's BLS under
        // the NODE's label, lands on the node's own `(label, BLS)` id.
        ...producerNodes(config).flatMap(node =>
          node.producers.map(label => ({
            label,
            source: SignatureKeySource.operator,
            nodeIndex: node.index,
            // beforeNodes, not afterOperators: a producing node renders these accounts'
            // `--signature-provider ...SSM:` specs at LAUNCH, so the parameters have to exist
            // by then. `ProducerIdentities` materializes the keys just before this runs.
            publishPhase: SignatureKeyPublishPhase.beforeNodes,
            keyTypes: [KeyType.K1, KeyType.BLS]
          }))
        ),
        // Batch operators + underwriters — wire + both outpost curves, the same
        // row a flow's operator publishes through `operatorKeyPublications`.
        ...range(config.batchOperatorCount).map(index =>
          operatorKeyIdentity(Constants.batchOperatorLabel(index), OperatorType.BATCH)
        ),
        ...range(config.underwriterCount).map(index =>
          operatorKeyIdentity(Constants.underwriterLabel(index), OperatorType.UNDERWRITER)
        )
      ]
    return identities.flatMap(identity =>
      identity.keyTypes.map(keyType => render(identity, keyType))
    )
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
    publishPhase: SignatureKeyPublishPhase
  ): ClusterBuildPhase<C> {
    const phase = ClusterBuildPhase.create<C>(parent, name, description)
    signatureProviderKeyPublications(config)
      .filter(publication => publication.publishPhase === publishPhase)
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
   * from under every consumer already holding it. A parameter that IS there is
   * retained only if it holds this run's key ({@link assertPublishedKeyMatches});
   * a stale copy fails the step rather than a daemon start.
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
    // ONE resolver over ONE shape: a node's key set and an operator account are
    // both `SigningKeySet`s, so `source` selects only WHERE the identity lives,
    // never how its curves are read.
    const identity: SigningKeySet = match(input.source)
        .with(SignatureKeySource.node, () => ctx.keyStore.node(input.nodeIndex).keys)
        .with(SignatureKeySource.operator, () =>
          ctx.keyStore.assertOperator(input.label)
        )
        .exhaustive(),
      privateKey = identityPrivateKey(identity, input.keyType, input.label)
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
        assertPublishedKeyMatches(input, region, existing, nativePrivateKey)
        log.info(
          `[keys] ${input.secretId} is already published in ${region} and holds this run's key — retained`
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

  /**
   * An existing parameter is retained ONLY when it holds the key this run
   * materialized. A different value is a stale copy: the daemon whose `SSM:`
   * spec fetches this id would sign with a key the chain never saw — the
   * republished K1 of a producer account after its node's key was rotated is
   * the canonical case — and retaining it silently would abort that daemon's
   * next start far from here. So it fails HERE, naming the parameter and
   * region an operator has to rotate or delete; a parameter is never
   * overwritten. Values are compared in their canonical NATIVE form, so an
   * equivalently-encoded copy is not mistaken for a different key.
   */
  function assertPublishedKeyMatches(
    publication: SignatureProviderKeyPublication,
    region: string,
    existing: string,
    nativePrivateKey: string
  ): void {
    const { secretId, label } = publication,
      curve = KeyType[publication.keyType],
      existingNative = Either.try(() =>
        privateKeyFromNativeString(publication.keyType, existing).toNativeString()
      )
        .ifLeft(error => {
          throw new NestedError(
            `KeySteps: ${secretId} in ${region} holds a value that is not a ${curve} private key`,
            { cause: error, context: { secretId, region, label, curve } }
          )
        })
        .getOrThrow()
    Assert.ok(
      existingNative === nativePrivateKey,
      `KeySteps: ${secretId} in ${region} already holds a DIFFERENT ${curve} key than the one materialized for ${label} — rotate or delete the stale parameter (it is never overwritten)`
    )
  }

  /** The private key of a producer-node key set for `keyType` (K1 / BLS). */
  function identityPrivateKey(
    identity: SigningKeySet,
    keyType: KeyType,
    label: string
  ): string {
    const assertPresent = <T>(key: T, curve: string): T => {
      Assert.ok(key != null, `KeySteps: ${label} has no ${curve} key`)
      return key
    }
    return match(keyType)
      .with(KeyType.K1, () => identity.wire.privateKey)
      .with(
        KeyType.BLS,
        () => assertPresent(identity.wireFinalizer, "wireFinalizer").privateKey
      )
      .with(
        KeyType.EM,
        () => assertPresent(identity.ethereum, "ethereum").privateKey
      )
      .with(
        KeyType.ED,
        () => assertPresent(identity.solana, "solana").privateKey
      )
      .otherwise(() => {
        throw new Error(`KeySteps: ${label} has no ${KeyType[keyType]} key`)
      })
  }

  /** The private key of an operator for `keyType` (K1 wire / EM ethereum / ED solana). */
}
