/**
 * WireOperatorProvisioningTool — THE operator-provisioning mechanism. Every
 * operator — producer, batch operator, underwriter, or a flow's extra operator —
 * is provisioned through {@link planOperatorAccountProvisioning}, which RETURNS a
 * {@link ClusterBuildPhaseGroup} with one {@link ClusterBuildPhase} per operator
 * (per the orchestration model: every WRITE is its own {@link ClusterBuildStep}
 * so the `Report` records it).
 *
 * Each Phase materializes the operator's type-appropriate keys and accumulates
 * its {@link OperatorAccount} into THE single {@link ClusterKeyStore}
 * (`ctx.keyStore`) — the one place keys are accessed from, keyed by the
 * operator's durable `label` handle — then runs the on-chain writes:
 *
 * - **producer**: materialize (the hosting node's K1; the node's own BLS when the
 *   node hosts this producer alone, else a finalizer key minted for the account)
 *   → create the WIRE account with that K1.
 * - **batch operator / underwriter**: materialize (UNIQUE generated K1 + EM + ED;
 *   the K1 imported into the kiod wallet so `account@active` signs) → (SSM, a
 *   FLOW's operator only: publish each key, so the daemon's `SSM:` specs
 *   resolve — the bootstrap's own operators are published by its operator
 *   publish phase) → create the WIRE account with that K1 → (optional) fund
 *   ETH / airdrop SOL → authex-link both chains → `opreg::regoperator`.
 *
 * Every account is created by `sysio` (`sysio::newaccount`, signed
 * `sysio@active`) under the operator's `label`, so `account` equals `label` for
 * every operator.
 *
 * Downstream write runners DERIVE the live ethers/web3 signing objects from the
 * stored typed keys via `utils/keyPairUtils` — no raw SDK handle is ever stored.
 * A flow-provisioned operator's daemon is started separately via
 * `OperatorDaemonTool.planDaemonStart` (needed once a non-bootstrapped op flips
 * ACTIVE and enters the schedule).
 */

import Assert from "node:assert"
import { LAMPORTS_PER_SOL } from "@solana/web3.js"
import { KeyType, Name, SysioContracts } from "@wireio/sdk-core"
import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import { match } from "ts-pattern"
import { getLogger } from "@wireio/shared"
import { SignatureProviderType } from "@wireio/cluster-tool-shared"
import { abiEnumValue } from "../../utils/enumUtils.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../../orchestration/ClusterBuildPhase.js"
import { ClusterBuildPhaseGroup } from "../../orchestration/ClusterBuildPhaseGroup.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { ClusterBuildParent } from "../../orchestration/ClusterBuildPhaseBase.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import type { OperatorAccount } from "../../orchestration/outputs/OperatorAccount.js"
import { KeySteps } from "../../orchestration/steps/KeySteps.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import type { WireFinalizerKeyPair } from "../../types/KeyPair.js"
import {
  ethereumSigner,
  solanaKeypair,
  solanaSdkPrivateKey
} from "../../utils/keyPairUtils.js"
import { AuthExLinkTool } from "../all/AuthExLinkTool.js"

const log = getLogger(__filename)

export namespace WireOperatorProvisioningTool {
  /** Default wei a flow operator's ETH wallet is funded to (covers a deposit + gas). */
  export const DefaultEthereumFundWei = 10n ** 18n // 1 ETH
  /** Default lamports airdropped to a flow operator's SOL keypair. */
  export const DefaultSolanaAirdropLamports = 5n * BigInt(LAMPORTS_PER_SOL)
  /** Creator account for provisioned operator accounts. */
  const AccountCreator = "sysio"

  /** One operator to provision — `type` drives which keys + steps its Phase runs. */
  export interface OperatorProvisioningSpec {
    /**
     * The operator's durable label handle — the `ClusterKeyStore` key and the
     * WIRE account name `sysio` creates for it (`defproducera`, `batchop.a`,
     * `uwrit.a`, a flow's `depositor`). Must be a valid WIRE `name`.
     */
    readonly label: string
    /** The operator's proto {@link OperatorType}. */
    readonly type: OperatorType
    /** Producer: index of the producer NODE whose block-signing K1 this label shares. */
    readonly producerNodeIndex?: number
    /**
     * Genesis producer only: the secret-id `{account}` segment its keys publish under, derived
     * at plan time by `NodeConfig.producerPublicationLabel` — the hosting node's name when the
     * node hosts this producer alone, else the producer's own label. OPP operators and
     * collateral-backed producers publish under their own label and carry none.
     */
    readonly publicationLabel?: string
    /**
     * Batch / underwriter: the identity already sits in `ctx.keyStore`, materialized by an
     * earlier phase (the bootstrap's `OperatorKeys`, via {@link planOperatorIdentityPhase}),
     * so the provisioning Phase runs no materialization step of its own. Default `false`: a
     * flow-provisioned operator materializes inside its own Phase.
     */
    readonly identityMaterialized?: boolean
    /** Batch / underwriter: `regoperator` bootstrapped flag (default `true`). */
    readonly isBootstrapped?: boolean
    /** Batch / underwriter: wei to seed the ETH wallet (omit to skip funding). */
    readonly fundEthereumWei?: bigint
    /** Batch / underwriter: lamports to airdrop the SOL keypair (omit to skip). */
    readonly airdropSolanaLamports?: bigint
  }

  // ── Composite: RETURNS a PhaseGroup — one Phase per operator ──────────────

  /**
   * Build the operator-provisioning {@link ClusterBuildPhaseGroup}: one
   * {@link ClusterBuildPhase} per operator (parallel), each materializing the
   * operator's identity into `ctx.keyStore` and running its provisioning writes.
   * Self-registers on `parent`. Flows call the SAME mechanism to provision extra
   * operators post-bootstrap — the resulting {@link OperatorAccount}s accumulate
   * into the same store.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - The group name (e.g. "Create batchops & uws").
   * @param description - Human-readable group description.
   * @param options - Step option overrides applied to every step.
   * @param operators - The operators to planOperatorAccountProvisioning (one Phase each).
   * @returns The self-registered phase group.
   */
  export function planOperatorAccountProvisioning<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operators: readonly OperatorProvisioningSpec[]
  ): ClusterBuildPhaseGroup<C> {
    const group = ClusterBuildPhaseGroup.create<C>(parent, name, description, {
      parallel: true
    })
    operators.forEach(spec => planProvisionPhase<C>(group, spec, options))
    return group
  }

  /** Dispatch one operator's Phase by type (self-registers on `group`). */
  function planProvisionPhase<C extends ClusterBuildContext>(
    group: ClusterBuildParent<C>,
    spec: OperatorProvisioningSpec,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    return match(spec.type)
      .with(OperatorType.PRODUCER, () => {
        // A GENESIS producer names its hosting node and shares that node's block-signing K1; a
        // COLLATERAL-BACKED one does not, and takes the same route every other bonded operator
        // does — unique keys, an account of its own, authex links on both chains, and
        // `opreg::regoperator`. The node index is what tells the two apart.
        return spec.producerNodeIndex != null
          ? planProvisionProducerPhase<C>(group, spec, options)
          : planProvisionOppOperatorPhase<C>(group, spec, options)
      })
      .with(OperatorType.BATCH, OperatorType.UNDERWRITER, () =>
        planProvisionOppOperatorPhase<C>(group, spec, options)
      )
      .otherwise(() => {
        throw new Error(
          `provision ${spec.label}: unsupported operator type ${OperatorType[spec.type] ?? spec.type}`
        )
      })
  }

  /**
   * Materialize every genesis producer's identity, ONE step each, as a Phase the caller
   * registers early in the bootstrap.
   *
   * Split from the account creation because the two have different earliest-possible points.
   * Materialization is pure key work (read the node's keys, mint a finalizer key for an account
   * that shares its node, accumulate the {@link OperatorAccount}) and must happen BEFORE the
   * producer nodes start, since a producing node renders one `--signature-provider` per hosted
   * account at launch. Creating the account is a chain WRITE and cannot happen until
   * `sysio.system` is deployed, which is much later. Keeping them in one phase forced the
   * earlier of the two to wait for the later.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - The phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides applied to every step.
   * @param specs - The genesis producers to materialize (each must name its hosting node and
   *   carry its plan-time `publicationLabel`).
   * @returns The self-registered phase.
   */
  export function planProducerIdentityPhase<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    specs: readonly OperatorProvisioningSpec[]
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      name,
      description,
      specs.map(spec => {
        const { label, producerNodeIndex, publicationLabel } = spec
        Assert.ok(
          producerNodeIndex != null,
          `materialize producer ${label}: producerNodeIndex is required`
        )
        Assert.ok(
          publicationLabel != null,
          `materialize producer ${label}: publicationLabel is required`
        )
        return planProducerMaterialization<C>(
          Report.Actor.Producer,
          `${label}-identity`,
          `materialize producer ${label} identity from node ${producerNodeIndex} (keys published under ${publicationLabel})`,
          options,
          label,
          producerNodeIndex,
          publicationLabel
        )
      })
    )
  }

  /**
   * Materialize every bootstrapped OPP operator's identity, ONE step each, as a Phase the
   * caller registers early in the bootstrap — the batch-operator counterpart of
   * {@link planProducerIdentityPhase}.
   *
   * Split from the provisioning Phase for the same reason: materialization is pure key work
   * (generate or adopt the unique K1 + EM + ED, import the K1 into kiod, accumulate the
   * {@link OperatorAccount}) and must happen BEFORE the Ethereum outpost deploys, because
   * `OPPInbound.initialize` seats a provisional roster of the operators' ETH addresses and
   * no address exists ahead of its random key. The account, the links and the registration
   * are chain WRITES that wait for the system contracts, much later. Each spec's
   * provisioning Phase is then planned with `identityMaterialized: true`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - The phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides applied to every step.
   * @param specs - The operators to materialize (label + type).
   * @returns The self-registered phase.
   */
  export function planOperatorIdentityPhase<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    specs: readonly OperatorProvisioningSpec[]
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      name,
      description,
      specs.map(spec =>
        planIdentityMaterialization<C>(
          operatorActor(spec.type),
          `${spec.label}-identity`,
          `generate ${spec.label} WIRE + ETH + SOL identity`,
          options,
          spec.label,
          spec.type
        )
      )
    )
  }

  /** The Report actor narrating an operator of `type`. */
  function operatorActor(type: OperatorType): Report.Actor {
    return match(type)
      .with(OperatorType.UNDERWRITER, () => Report.Actor.Underwriter)
      .with(OperatorType.PRODUCER, () => Report.Actor.Producer)
      .otherwise(() => Report.Actor.BatchOperator)
  }

  /**
   * A genesis producer's Phase: create its account.
   *
   * Its identity is materialized earlier, by {@link planProducerIdentityPhase} — see there for
   * why the two cannot share a phase.
   */
  function planProvisionProducerPhase<C extends ClusterBuildContext>(
    group: ClusterBuildParent<C>,
    spec: OperatorProvisioningSpec,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const { label, producerNodeIndex } = spec
    Assert.ok(
      producerNodeIndex != null,
      `provision producer ${label}: producerNodeIndex is required`
    )
    return ClusterBuildPhase.create<C>(group, `Provision ${label}`, `provision producer ${label}`, [
      planAccountCreation<C>(
        Report.Actor.Producer,
        `${label}-account`,
        `create WIRE account ${label}`,
        options,
        label
      )
    ])
  }

  /**
   * A batch-operator / underwriter Phase: materialize keys → account creation →
   * (optional) fund ETH / airdrop SOL → authex-link both chains → register.
   * Funding steps are included only when the spec supplies an amount (bootstrap
   * ops skip them; deposit flows opt in). Every step resolves the operator by its
   * durable `label` handle and reads `account` off the stored
   * {@link OperatorAccount}.
   */
  function planProvisionOppOperatorPhase<C extends ClusterBuildContext>(
    group: ClusterBuildParent<C>,
    spec: OperatorProvisioningSpec,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const {
        label,
        type,
        identityMaterialized = false,
        isBootstrapped,
        fundEthereumWei,
        airdropSolanaLamports
      } = spec,
      actor = operatorActor(type),
      // External-outpost mode: operators are pre-funded out-of-band on the REAL
      // chains — there is no anvil faucet / SOL faucet — so the outpost-chain
      // funding steps are gated out; every depot-side step still runs.
      isExternalOutpost = group.context.config?.externalOutposts != null
    return ClusterBuildPhase.create<C>(group, `Provision ${label}`, `provision operator ${label}`, [
      ...(identityMaterialized
        ? []
        : [
            planIdentityMaterialization<C>(
              actor,
              `${label}-identity`,
              `generate ${label} WIRE + ETH + SOL identity`,
              options,
              label,
              type
            )
          ]),
      ...planOperatorKeyPublications<C>(group, actor, options, label, type),
      planAccountCreation<C>(
        actor,
        `${label}-account`,
        `create WIRE account ${label}`,
        options,
        label
      ),
      ...(fundEthereumWei != null && !isExternalOutpost
        ? [
            planEthereumFunding<C>(
              actor,
              `${label}-fund-ethereum`,
              `fund ${label} ETH wallet`,
              options,
              label,
              fundEthereumWei
            )
          ]
        : []),
      ...(airdropSolanaLamports != null && !isExternalOutpost
        ? [
            planSolanaAirdrop<C>(
              actor,
              `${label}-airdrop-solana`,
              `airdrop SOL to ${label}`,
              options,
              label,
              airdropSolanaLamports
            )
          ]
        : []),
      planAuthexLink<C>(
        actor,
        `${label}-authex-ethereum`,
        `authex-link ${label} on Ethereum`,
        options,
        label,
        ChainKind.EVM
      ),
      planAuthexLink<C>(
        actor,
        `${label}-authex-solana`,
        `authex-link ${label} on Solana`,
        options,
        label,
        ChainKind.SVM
      ),
      planRegistration<C>(
        actor,
        `${label}-register`,
        `register operator ${label}`,
        options,
        label,
        type,
        // A collateral-backed producer is on this route BECAUSE it is not a genesis one: a
        // bootstrapped registration would be ACTIVE at once and refused every deposit after.
        isBootstrapped ?? type !== OperatorType.PRODUCER
      )
    ])
  }

  /**
   * The SSM publish steps for a FLOW-provisioned OPP operator's freshly
   * materialized keys — one per curve of `KeySteps.operatorKeyTypes` — planned
   * right after materialization so the parameters exist long before
   * `OperatorDaemonTool.planDaemonStart` renders the daemon's `SSM:` specs for
   * them. Nothing is planned under KEY / KIOD, and nothing for a label the
   * bootstrap's own operator publish phase already covers
   * (`KeySteps.isPublishedAtBootstrap`), so a bootstrapped batch operator's
   * keys are still published exactly once.
   */
  function planOperatorKeyPublications<C extends ClusterBuildContext>(
    group: ClusterBuildParent<C>,
    actor: Report.Actor,
    options: ClusterBuildStepOptions,
    label: string,
    type: OperatorType
  ): ClusterBuildStep<C, KeySteps.PublishSignatureProviderKeyInput>[] {
    const config = group.context.config
    if (
      config?.signatureProvider?.type !== SignatureProviderType.SSM ||
      KeySteps.isPublishedAtBootstrap(config, label)
    ) {
      return []
    }
    return KeySteps.operatorKeyPublications(config, label, type).map(publication =>
      KeySteps.planPublishSignatureProviderKey<C>(
        actor,
        `${label}-publish-${KeyType[publication.keyType]}`,
        `publish ${label} ${KeyType[publication.keyType]} key → SSM`,
        options,
        publication
      )
    )
  }

  // ── Step: materialize an OPP operator's identity (keys → store + wallet) ──

  /** Input for {@link planIdentityMaterialization}. */
  export interface MaterializeIdentityInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.MaterializeIdentityInput"
    readonly label: string
    readonly type: OperatorType
  }

  /**
   * Generate the operator's UNIQUE WIRE K1 (its label controller — imported
   * into the kiod wallet so `account@active` can sign), plus its ETH (EM) + SOL
   * (ED) keys, all via the {@link KeyGenerator} facade — then accumulate the
   * {@link OperatorAccount} into `ctx.keyStore`.
   */
  export function planIdentityMaterialization<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    type: OperatorType
  ): ClusterBuildStep<C, MaterializeIdentityInput> {
    return ClusterBuildStep.create<C, MaterializeIdentityInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
        label,
        type
      },
      runIdentityMaterialization
    )
  }

  /**
   * Named runner — adopt or generate K1/ED/EM, import the K1 into kiod, store
   * the label.
   *
   * An identity the context ALREADY HOLDS (`ctx.keyStore.operator(label)`) is
   * adopted whole: that is how a scenario pre-creates its operators' keys
   * before the bootstrap composes — the KEY-custody twin of adopting an SSM
   * parameter or a KMS alias (`KeySteps.adoptOrCreateSignatureProviderKey`),
   * and what `batchOperatorKeyPolicy: adoptOnly` adopts from on a cluster with
   * no AWS custody store.
   */
  export async function runIdentityMaterialization<C extends ClusterBuildContext>(
    ctx: C,
    input: MaterializeIdentityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // The handle is the account name `sysio` creates for the operator, and also a filesystem
    // path segment (`NodeConfig.adHocNodeName` → `node_<label>` → `NodeConfig.nodePath`) and an
    // SSM parameter-name segment.
    Assert.ok(
      Name.isValid(input.label),
      `materializeIdentity: operator handle "${input.label}" must be a valid WIRE name (it is the operator's account)`
    )
    const held = ctx.keyStore.operator(input.label)
    if (held != null) {
      await adoptHeldIdentity(ctx, held, input)
      return
    }
    // Every curve is a fresh random key — nothing derives from a mnemonic or an
    // index, on a flow cluster exactly as on a real deployment.
    const keyContext = KeySteps.keyGeneratorContext(ctx)
    // D21 — a key the AWS account already owns is ADOPTED, never regenerated,
    // and the read has to happen HERE: the very next steps set this account's
    // ON-CHAIN authority (`newaccount`) and both authex links from these keys.
    const [wire, solana, ethereum] = await Promise.all([
      KeySteps.adoptOrCreateSignatureProviderKey(
        ctx.config,
        KeyType.K1,
        input.label,
        keyContext,
        { purpose: `operator ${input.label} — WIRE account key (K1)` }
      ),
      KeySteps.adoptOrCreateSignatureProviderKey(
        ctx.config,
        KeyType.ED,
        input.label,
        keyContext,
        { purpose: `operator ${input.label} — solana outpost key (ED)` }
      ),
      KeySteps.adoptOrCreateSignatureProviderKey(
        ctx.config,
        KeyType.EM,
        input.label,
        keyContext,
        { purpose: `operator ${input.label} — ethereum outpost key (EM)` }
      )
    ])
    // A collateral-backed PRODUCER reaches this path too, and it needs a finalizer key of its
    // own before it can hold a rank position at all — one of the three conditions
    // `is_schedulable` tests. Batch operators and underwriters have no finality role and get
    // none, which is also why the publication walker publishes no BLS parameter for them.
    const wireFinalizer =
      input.type === OperatorType.PRODUCER
        ? await KeySteps.adoptOrCreateSignatureProviderKey(
            ctx.config,
            KeyType.BLS,
            input.label,
            keyContext,
            { purpose: `producer ${input.label} — finalizer key (BLS)` }
          )
        : null
    const operator: OperatorAccount = {
      label: input.label,
      // An OPP operator owns its generated keys — published under its own handle.
      publicationLabel: input.label,
      // `sysio` creates the account under the handle itself.
      account: input.label,
      type: input.type,
      wire,
      ethereum,
      solana,
      ...(wireFinalizer != null ? { wireFinalizer } : {})
    }
    await importSigningKeys(ctx, operator)
    ctx.keyStore.setOperator(operator)
    log.info(
      `[provision] ${input.label} — WIRE ${wire.publicKey}, ETH ${ethereum.address}, SOL ${solana.publicKey}`
    )
  }

  /**
   * Adopt an identity the context already holds: its curves and type must
   * match the step's, its wire key is imported into kiod exactly like a
   * generated one, and the adoption lands in the step's `extra`.
   */
  async function adoptHeldIdentity<C extends ClusterBuildContext>(
    ctx: C,
    held: OperatorAccount,
    input: MaterializeIdentityInput
  ): Promise<void> {
    Assert.strictEqual(
      held.type,
      input.type,
      `materializeIdentity: ${input.label} is held as a ${OperatorType[held.type]}, not a ${OperatorType[input.type]}`
    )
    Assert.ok(
      held.ethereum != null && held.solana != null,
      `materializeIdentity: the held identity ${input.label} carries no outpost keys`
    )
    Assert.ok(
      input.type !== OperatorType.PRODUCER || held.wireFinalizer != null,
      `materializeIdentity: the held producer identity ${input.label} carries no finalizer key`
    )
    await importSigningKeys(ctx, held)
    StepExtraRecorder.note(`adopted the identity ${input.label} the context already held`, {
      label: input.label,
      wire: held.wire.publicKey,
      ethereum: held.ethereum.address,
      solana: held.solana.publicKey
    })
    log.info(
      `[provision] ${input.label} — adopted held identity: WIRE ${held.wire.publicKey}, ETH ${held.ethereum.address}, SOL ${held.solana.publicKey}`
    )
  }

  /**
   * Import the operator's unique wire key so kiod can sign `account@active`
   * (authex links, registration, and any operator-signed flow actions), and its
   * finalizer key so a KIOD-provider node can vote with it.
   */
  async function importSigningKeys<C extends ClusterBuildContext>(
    ctx: C,
    operator: OperatorAccount
  ): Promise<void> {
    const wallet = await ctx.wire.wallet.getOrCreate()
    await wallet.addPrivateKey(operator.wire.privateKey)
    if (operator.wireFinalizer != null) {
      await wallet.addPrivateKey(operator.wireFinalizer.privateKey)
    }
  }

  // ── Step: materialize a producer's identity (from its node's shared keys) ──

  /** Input for {@link planProducerMaterialization}. */
  export interface MaterializeProducerInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.MaterializeProducerInput"
    readonly label: string
    readonly producerNodeIndex: number
    /** The secret-id `{account}` segment, from `NodeConfig.producerPublicationLabel` at plan time. */
    readonly publicationLabel: string
  }

  /**
   * Materialize a genesis producer's {@link OperatorAccount} from its hosting NODE's generated
   * key set. Which keys it signs with follows the node's topology, decided at plan time by
   * `NodeConfig.producerPublicationLabel` and carried here as `publicationLabel`:
   *
   * - **The node hosts this producer alone** (`publicationLabel` is the node's name): the
   *   producer IS the node's identity — it signs blocks with the node's K1 and votes with the
   *   node's BLS, both published under the node's name, the path a deployment fetches by node.
   *   Nothing is generated, and nothing is imported: the wallet step already holds both node keys
   *   (kiod rejects a re-import with `key_exist_exception`).
   * - **The node hosts several producers**: the K1 stays node-shared, but each account gets a
   *   BLS finalizer key MINTED FOR IT, published under its own label. `regfinkey` enforces a
   *   GLOBAL uniqueness check on the finalizer key, so siblings sharing their node's one BLS key
   *   means only the first of them can ever register — and without a registered key a producer
   *   holds no rank position, so it is never scheduled, never paid, and never snapshot-eligible.
   *   Block-signing keys carry no such constraint (`setprodkeys` maps each producer to its host
   *   node's K1). The node K1 is republished under each account's label alongside its BLS, so
   *   every parameter holds exactly the key its owner signs with.
   */
  export function planProducerMaterialization<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    producerNodeIndex: number,
    publicationLabel: string
  ): ClusterBuildStep<C, MaterializeProducerInput> {
    return ClusterBuildStep.create<C, MaterializeProducerInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
        label,
        producerNodeIndex,
        publicationLabel
      },
      runProducerMaterialization
    )
  }

  /**
   * Named runner — take the hosting node's keys (its BLS too when it hosts this producer alone,
   * else a finalizer key minted for the account), accumulate the OperatorAccount.
   */
  export async function runProducerMaterialization<C extends ClusterBuildContext>(
    ctx: C,
    input: MaterializeProducerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const node = assertPlannedProducerNode(ctx, input.producerNodeIndex)
    // The plan-time label is re-derived from the SAME topology here, so a drifted input fails
    // before any key is materialized rather than at publication or daemon start.
    Assert.ok(
      NodeConfig.producerPublicationLabel(node, input.label) === input.publicationLabel,
      `materialize producer ${input.label}: publicationLabel ${input.publicationLabel} does not match node ${node.name}'s topology`
    )
    const nodeKeys = ctx.keyStore.node(input.producerNodeIndex),
      isNodeIdentity = input.publicationLabel === node.name,
      wireFinalizer = isNodeIdentity
        ? nodeKeys.keys.wireFinalizer
        : await adoptOrCreateProducerFinalizerKey(ctx, input.label)
    // `sysio` creates the account under the handle itself.
    ctx.keyStore.setOperator({
      label: input.label,
      publicationLabel: input.publicationLabel,
      account: input.label,
      type: OperatorType.PRODUCER,
      wire: nodeKeys.keys.wire,
      wireFinalizer
    })
    // Descriptive payload only — the node's full pairs live under the step that GENERATED them
    // (generate-keys); here we say whose keys this account signs with.
    StepExtraRecorder.note(
      isNodeIdentity
        ? `producer ${input.label} signs blocks and votes with ${node.name}'s K1 + BLS (published under ${node.name})`
        : `producer ${input.label} signs blocks with ${node.name}'s K1 and its own finalizer key (published under ${input.publicationLabel})`,
      {
        label: input.label,
        publicationLabel: input.publicationLabel,
        wirePublicKey: nodeKeys.keys.wire.publicKey,
        blsPublicKey: wireFinalizer.publicKey
      }
    )
    log.info(
      `[provision] producer ${input.label} — ${node.name} (K1 ${nodeKeys.keys.wire.publicKey}, ${isNodeIdentity ? "node" : "own"} BLS ${wireFinalizer.publicKey}, published under ${input.publicationLabel})`
    )
  }

  /**
   * The planned producer node at `producerNodeIndex` — resolved from `NodeConfig.plan`, the ONE
   * author of the producer→node assignment the plan-time `publicationLabel` was derived from.
   */
  function assertPlannedProducerNode(
    ctx: ClusterBuildContext,
    producerNodeIndex: number
  ): NodeConfig {
    const node = NodeConfig.plan(ctx.config).find(
      planned =>
        planned.role === NodeRole.producer && planned.index === producerNodeIndex
    )
    Assert.ok(
      node != null,
      `materialize producer: no planned producer node at index ${producerNodeIndex}`
    )
    return node
  }

  /**
   * A finalizer key of `label`'s own, for a producer sharing its node with siblings: adopted when
   * the AWS account already owns the parameter (an SSM identity is durable and never
   * regenerated), else generated — then imported into the kiod wallet, which holds only the
   * node's keys, so a KIOD-provider node can vote with it.
   */
  async function adoptOrCreateProducerFinalizerKey(
    ctx: ClusterBuildContext,
    label: string
  ): Promise<WireFinalizerKeyPair> {
    const wireFinalizer = await KeySteps.adoptOrCreateSignatureProviderKey(
        ctx.config,
        KeyType.BLS,
        label,
        KeySteps.keyGeneratorContext(ctx),
        { purpose: `producer ${label} — finalizer key (BLS)` }
      ),
      wallet = await ctx.wire.wallet.getOrCreate()
    await wallet.addPrivateKey(wireFinalizer.privateKey)
    return wireFinalizer
  }

  // ── Step: create an operator's WIRE account with ITS OWN key (write) ──────

  /** Input for {@link planAccountCreation}. */
  export interface CreateAccountInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.CreateAccountInput"
    readonly label: string
  }

  /**
   * Create an operator's WIRE account as `sysio` (name = `account`, which equals
   * its durable `label` handle; owner = active = the operator's `wire` public key
   * from `ctx.keyStore`). Requires the operator's materialize step to have run
   * first.
   */
  export function planAccountCreation<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, CreateAccountInput> {
    return ClusterBuildStep.create<C, CreateAccountInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireOperatorProvisioningTool.CreateAccountInput", label },
      runAccountCreation
    )
  }

  /** Named runner — ONE `newaccount` as `sysio`, keyed by the stored operator's `wire` key. */
  export async function runAccountCreation<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateAccountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.label)
    await ctx.wire.createAccount(
      AccountCreator,
      operator.account,
      operator.wire.publicKey,
      operator.wire.publicKey
    )
  }

  // ── Step: register the operator on sysio.opreg (write) ────────────────────

  /** Input for {@link planRegistration}. */
  export interface RegistrationInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.RegistrationInput"
    readonly label: string
    readonly type: OperatorType
    readonly isBootstrapped: boolean
  }

  /**
   * Register the operator on `sysio.opreg` (`regoperator`). The registered
   * name is the operator's `account`, resolved from `ctx.keyStore` at RUN time.
   */
  export function planRegistration<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    type: OperatorType,
    isBootstrapped: boolean
  ): ClusterBuildStep<C, RegistrationInput> {
    return ClusterBuildStep.create<C, RegistrationInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireOperatorProvisioningTool.RegistrationInput",
        label,
        type,
        isBootstrapped
      },
      runRegistration
    )
  }

  /** Named runner — ONE `opreg::regoperator` for the operator's resolved label. */
  export async function runRegistration<C extends ClusterBuildContext>(
    ctx: C,
    input: RegistrationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.label)
    await ctx.wire
      .getSysioContract(SysioContracts.SysioContractName.opreg)
      .actions.regoperator.invoke({
        // The depot keys `sysio.opreg::operators` by the ON-CHAIN account — the
        // same value the operator's daemon passes as `--*-account`. `account:`
        // is the generated ABI field name and never renames with the harness.
        account: operator.account,
        // proto OperatorType + the ABI mirror share numeric values —
        // resolved through the checked bridge.
        type: abiEnumValue(SysioContracts.SysioOpregOperatortype, input.type),
        is_bootstrapped: input.isBootstrapped
      })
  }

  // ── Step: fund the operator's ETH wallet (write) ─────────────────────────

  /** Input for {@link planEthereumFunding}. */
  export interface FundEthereumInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.FundEthereumInput"
    readonly label: string
    readonly wei: bigint
  }

  /**
   * A single `anvil_setBalance` on the operator's wallet — the local chain's
   * faucet, the ETH counterpart of {@link planSolanaAirdrop}. A fresh random
   * wallet starts at zero, so the balance set IS the funding.
   */
  export function planEthereumFunding<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    wei: bigint
  ): ClusterBuildStep<C, FundEthereumInput> {
    return ClusterBuildStep.create<C, FundEthereumInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireOperatorProvisioningTool.FundEthereumInput", label, wei },
      runEthereumFunding
    )
  }

  /** Named runner — ONE `anvil_setBalance` on the operator wallet. */
  export async function runEthereumFunding<C extends ClusterBuildContext>(
    ctx: C,
    input: FundEthereumInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.label)
    Assert.ok(
      operator.ethereum,
      `fund ${input.label} ETH wallet: the operator has no Ethereum key`
    )
    await ctx.ethereum.setBalance(operator.ethereum.address, input.wei)
  }

  // ── Step: airdrop SOL to the operator keypair (write) ────────────────────

  /** Input for {@link planSolanaAirdrop}. */
  export interface AirdropSolanaInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.AirdropSolanaInput"
    readonly label: string
    readonly lamports: bigint
  }

  /** A single `requestAirdrop` to the operator's SOL keypair. */
  export function planSolanaAirdrop<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    lamports: bigint
  ): ClusterBuildStep<C, AirdropSolanaInput> {
    return ClusterBuildStep.create<C, AirdropSolanaInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireOperatorProvisioningTool.AirdropSolanaInput", label, lamports },
      runSolanaAirdrop
    )
  }

  /** Named runner — ONE `requestAirdrop` + confirm, to the derived SOL keypair. */
  export async function runSolanaAirdrop<C extends ClusterBuildContext>(
    ctx: C,
    input: AirdropSolanaInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.label)
    const signature = await ctx.solana.connection.requestAirdrop(
      solanaKeypair(operator.solana).publicKey,
      Number(input.lamports)
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `provision airdrop ${input.label}`
    )
  }

  // ── Step: authex-link the operator's chain key (write) ───────────────────

  /** Input for {@link planAuthexLink}. */
  export interface AuthexLinkInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.AuthexLinkInput"
    readonly label: string
    readonly chainKind: ChainKind
  }

  /** A single `sysio.authex::createlink` write for the operator on one chain. */
  export function planAuthexLink<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    chainKind: ChainKind
  ): ClusterBuildStep<C, AuthexLinkInput> {
    return ClusterBuildStep.create<C, AuthexLinkInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireOperatorProvisioningTool.AuthexLinkInput", label, chainKind },
      runAuthexLink
    )
  }

  /** Named runner — ONE `createlink` write, deriving the operator's live keys from `ctx.keyStore`. */
  export async function runAuthexLink<C extends ClusterBuildContext>(
    ctx: C,
    input: AuthexLinkInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // The link message + `account@active` auth carry the operator's on-chain `account`.
    const operator = ctx.keyStore.assertOperator(input.label)
    if (input.chainKind === ChainKind.EVM) {
      // The link is signed offline: a provider-less signer keeps this depot
      // write from touching an outpost (none may be contacted when external).
      // The custody facade signs through KMS when the EM key lives there.
      await AuthExLinkTool.createLink(ctx.wire, {
        chainKind: ChainKind.EVM,
        account: operator.account,
        publicKey: operator.ethereum.publicKey,
        signer: await ethereumSigner(operator.ethereum)
      })
      return
    }
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.SVM,
      account: operator.account,
      privateKey: solanaSdkPrivateKey(operator.solana)
    })
  }
}
