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
 * - **producer**: materialize (node-shared K1+BLS from the store's node sets) →
 *   create the WIRE account with that K1 (`account` = `label`; producers
 *   never go through `roa::newuser`).
 * - **batch operator / underwriter**: materialize (UNIQUE generated K1 + EM + ED;
 *   the K1 imported into the kiod wallet so `account@active` signs) →
 *   node-owner-sponsored account creation (`sysio.roa::newuser` as the bootstrap
 *   node owner with a FRESHLY MINTED single-use nonce; the chain assigns a
 *   generated `<nodeOwner>.<suffix>` name, adopted from the `sponsors` table
 *   into `account`) → (optional) fund ETH / airdrop SOL → authex-link both
 *   chains → `opreg::regoperator`.
 *
 * Downstream write runners DERIVE the live ethers/web3 signing objects from the
 * stored typed keys via `utils/keyPairUtils` — no raw SDK handle is ever stored.
 * A flow-provisioned operator's daemon is started separately via
 * `OperatorDaemonTool.planDaemonStart` (needed once a non-bootstrapped op flips
 * ACTIVE and enters the schedule).
 */

import Assert from "node:assert"
import { LAMPORTS_PER_SOL } from "@solana/web3.js"
import { KeyType, PrivateKey, SysioContracts } from "@wireio/sdk-core"
import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import { match } from "ts-pattern"
import { getLogger } from "@wireio/shared"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { serialize } from "../../utils/asyncUtils.js"
import { abiEnumValue } from "../../utils/enumUtils.js"
import {
  clearNonceCache,
  resolveLatestNonce
} from "../../utils/ethereumUtils.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../../orchestration/ClusterBuildPhase.js"
import { ClusterBuildPhaseGroup } from "../../orchestration/ClusterBuildPhaseGroup.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { ClusterBuildParent } from "../../orchestration/ClusterBuildPhaseBase.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { KeySteps } from "../../orchestration/steps/KeySteps.js"
import { isNotEmpty } from "../../utils/predicateUtils.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import {
  ethereumSigner,
  solanaKeypair,
  solanaSdkPrivateKey
} from "../../utils/keyPairUtils.js"
import { newSponsorNonce } from "../../utils/nonceUtils.js"
import { AuthExLinkTool } from "../all/AuthExLinkTool.js"

const log = getLogger(__filename)

export namespace WireOperatorProvisioningTool {
  /** Default wei seeded into a flow operator's ETH wallet (covers a deposit + gas). */
  export const DefaultEthereumFundWei = 10n ** 18n // 1 ETH
  /**
   * Serialization key for ETH funding sends — they all share ONE anvil signer,
   * so they share one nonce sequence. See {@link runEthereumFunding}.
   */
  const EthereumFundingQueueKey = "WireOperatorProvisioningTool.ethereumFunding"
  /** Default lamports airdropped to a flow operator's SOL keypair. */
  export const DefaultSolanaAirdropLamports = 5n * BigInt(LAMPORTS_PER_SOL)
  /** Creator account for provisioned operator accounts. */
  const AccountCreator = "sysio"
  /**
   * Row ceiling for the `sysio.roa::sponsors` read-back. The table holds one row
   * per sponsored operator under the bootstrap node owner; the harness roster
   * ceiling is `MaxBatchOperatorRoster` batch operators plus underwriters plus
   * any flow-provisioned extras, so this sits well clear of it and never relies
   * on the client's own default.
   */
  const SponsorsRowLimit = 500

  /** One operator to provision — `type` drives which keys + steps its Phase runs. */
  export interface OperatorProvisioningSpec {
    /**
     * The operator's durable label handle — the `ClusterKeyStore` key.
     * Producers: the WIRE account name itself (`defproducera`), which is also
     * their `account`. Batch operators / underwriters: the deterministic
     * handle (`batchop.a`, `uwrit.a`, a flow's `depositor`) their generated
     * `account` is later adopted against. Must be 1..12 chars.
     */
    readonly label: string
    /** The operator's proto {@link OperatorType}. */
    readonly type: OperatorType
    /** Producer: index of the producer NODE whose K1+BLS this label shares. */
    readonly producerNodeIndex?: number
    /** Producer: NAME of that node — the label its keys are published under. */
    readonly producerNodeName?: string
    /** Batch / underwriter: anvil-mnemonic HD index for the operator's ETH wallet. */
    readonly ethereumHdIndex?: number
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
      .with(OperatorType.PRODUCER, () => planProvisionProducerPhase<C>(group, spec, options))
      .with(OperatorType.BATCH, OperatorType.UNDERWRITER, () =>
        planProvisionOppOperatorPhase<C>(group, spec, options)
      )
      .otherwise(() => {
        throw new Error(
          `provision ${spec.label}: unsupported operator type ${OperatorType[spec.type] ?? spec.type}`
        )
      })
  }

  /** A producer's Phase: materialize its (node-shared) identity, then create its account. */
  function planProvisionProducerPhase<C extends ClusterBuildContext>(
    group: ClusterBuildParent<C>,
    spec: OperatorProvisioningSpec,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const { label, producerNodeIndex, producerNodeName } = spec
    Assert.ok(
      producerNodeIndex != null,
      `provision producer ${label}: producerNodeIndex is required`
    )
    Assert.ok(
      isNotEmpty(producerNodeName),
      `provision producer ${label}: producerNodeName is required — it is the label this account's keys are published under`
    )
    return ClusterBuildPhase.create<C>(group, `Provision ${label}`, `provision producer ${label}`, [
      planProducerMaterialization<C>(
        Report.Actor.Producer,
        `${label}-identity`,
        `materialize producer ${label} identity from node ${producerNodeIndex}`,
        options,
        label,
        producerNodeIndex,
        producerNodeName
      ),
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
   * A batch-operator / underwriter Phase: materialize keys → node-owner-sponsored
   * account creation → (optional) fund ETH / airdrop SOL → authex-link both
   * chains → register. Funding steps are included only when the spec supplies an
   * amount (bootstrap ops skip them; deposit flows opt in). Steps after the
   * sponsored creation resolve the operator by its durable `label` handle and
   * read the GENERATED `account` off the stored {@link OperatorAccount}.
   */
  function planProvisionOppOperatorPhase<C extends ClusterBuildContext>(
    group: ClusterBuildParent<C>,
    spec: OperatorProvisioningSpec,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const {
        label,
        type,
        ethereumHdIndex,
        isBootstrapped,
        fundEthereumWei,
        airdropSolanaLamports
      } = spec,
      isUnderwriter = type === OperatorType.UNDERWRITER,
      actor = isUnderwriter ? Report.Actor.Underwriter : Report.Actor.BatchOperator,
      // External-outpost mode: operators are pre-funded out-of-band on the REAL
      // chains — there is no anvil prefund / SOL faucet — so the outpost-chain
      // funding steps are gated out; every depot-side step still runs.
      isExternalOutpost = group.context.config?.externalOutposts != null
    Assert.ok(
      ethereumHdIndex != null,
      `provision operator ${label}: ethereumHdIndex is required`
    )
    return ClusterBuildPhase.create<C>(group, `Provision ${label}`, `provision operator ${label}`, [
      planIdentityMaterialization<C>(
        actor,
        `${label}-identity`,
        `generate ${label} WIRE + ETH + SOL identity`,
        options,
        label,
        type,
        ethereumHdIndex
      ),
      planSponsoredAccountCreation<C>(
        actor,
        `${label}-account`,
        `create ${label}'s WIRE account via the node owner (roa::newuser)`,
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
        isBootstrapped ?? true
      )
    ])
  }

  // ── Step: materialize an OPP operator's identity (keys → store + wallet) ──

  /** Input for {@link planIdentityMaterialization}. */
  export interface MaterializeIdentityInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.MaterializeIdentityInput"
    readonly label: string
    readonly type: OperatorType
    readonly ethereumHdIndex: number
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
    type: OperatorType,
    ethereumHdIndex: number
  ): ClusterBuildStep<C, MaterializeIdentityInput> {
    return ClusterBuildStep.create<C, MaterializeIdentityInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireOperatorProvisioningTool.MaterializeIdentityInput",
        label,
        type,
        ethereumHdIndex
      },
      runIdentityMaterialization
    )
  }

  /** Named runner — generate K1/ED/EM, import the K1 into kiod, store the label. */
  export async function runIdentityMaterialization<C extends ClusterBuildContext>(
    ctx: C,
    input: MaterializeIdentityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // The handle is a filesystem path segment (`daemonNodeName` → `node_<label>`
    // → `NodeConfig.nodePath`) and an SSM parameter-name segment, so the 12-char
    // bound stays — it is no longer a WIRE `name` constraint (the on-chain name
    // is `account`, generated by the depot).
    Assert.ok(
      input.label.length > 0 && input.label.length <= 12,
      `materializeIdentity: operator handle "${input.label}" must be 1..12 chars (it is a node-directory and SSM path segment)`
    )
    // EM keys derive from the run's mnemonic: the CLUSTER-SCOPED one an SSM
    // cluster generated in `KeySteps.runGenerateNodeKeys`, else the published
    // anvil mnemonic (KEY / KIOD — every flow keeps its byte-identical wallets).
    const keyContext = KeyGenerator.context(
      ctx.config.executables.clio,
      ctx.config.buildPath,
      KeySteps.ethereumMnemonic(ctx)
    )
    // D21 — a key the AWS account already owns is ADOPTED, never regenerated,
    // and the read has to happen HERE: the very next steps set this account's
    // ON-CHAIN authority (`roa::newuser`) and both authex links from these keys.
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
        {
          ethereumHdIndex: input.ethereumHdIndex,
          purpose: `operator ${input.label} — ethereum outpost key (EM)`
        }
      )
    ])
    // Import the operator's unique wire key so kiod can sign `account@active`
    // (authex links, registration, and any operator-signed flow actions).
    const wallet = await ctx.wire.wallet.getOrCreate()
    await wallet.addPrivateKey(wire.privateKey)
    // `account` stays unset until the sponsored-creation step adopts the
    // depot-generated name — `label` is the durable handle from here on.
    ctx.keyStore.setOperator({
      label: input.label,
      // An OPP operator owns its generated keys — published under its own handle.
      publicationLabel: input.label,
      type: input.type,
      wire,
      ethereum,
      solana
    })
    log.info(
      `[provision] ${input.label} — WIRE ${wire.publicKey}, ETH ${ethereum.address} (hd=${input.ethereumHdIndex}), SOL ${solana.publicKey}`
    )
  }

  // ── Step: materialize a producer's identity (from its node's shared keys) ──

  /** Input for {@link planProducerMaterialization}. */
  export interface MaterializeProducerInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.MaterializeProducerInput"
    readonly label: string
    readonly producerNodeIndex: number
    /** The hosting node's NAME — recorded as the account's `publicationLabel`. */
    readonly producerNodeName: string
  }

  /**
   * Materialize a producer's {@link OperatorAccount} from its NODE's generated
   * K1+BLS in `ctx.keyStore` — sibling producer accounts on the same node share
   * that key set (the node signs blocks for all of them). Pure read + accumulate.
   */
  export function planProducerMaterialization<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    producerNodeIndex: number,
    producerNodeName: string
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
        producerNodeName
      },
      runProducerMaterialization
    )
  }

  /** Named runner — read the producer node's keys, accumulate the producer OperatorAccount. */
  export async function runProducerMaterialization<C extends ClusterBuildContext>(
    ctx: C,
    input: MaterializeProducerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const nodeKeys = ctx.keyStore.node(input.producerNodeIndex)
    // A producer never calls `roa::newuser`, so its ON-CHAIN name IS its durable
    // handle — `account` equals `label` from materialization onward.
    ctx.keyStore.setOperator({
      label: input.label,
      // The keys just read belong to the NODE and are published under its name —
      // recorded HERE, where the hand-over happens, so nothing re-derives it.
      publicationLabel: input.producerNodeName,
      account: input.label,
      type: OperatorType.PRODUCER,
      wire: nodeKeys.keys.wire,
      wireFinalizer: nodeKeys.keys.wireFinalizer
    })
    // Descriptive payload only — the full pairs live under the step that
    // GENERATED them (generate-keys); here we just say whose set this is.
    StepExtraRecorder.note(
      `producer ${input.label} assumes node_${String(input.producerNodeIndex).padStart(2, "0")}'s signing set`,
      {
        label: input.label,
        wirePublicKey: nodeKeys.keys.wire.publicKey,
        blsPublicKey: nodeKeys.keys.wireFinalizer.publicKey
      }
    )
    log.info(
      `[provision] producer ${input.label} — node ${input.producerNodeIndex} (K1 ${nodeKeys.keys.wire.publicKey})`
    )
  }

  // ── Step: create a producer's WIRE account with ITS OWN key (write) ───────

  /** Input for {@link planAccountCreation}. */
  export interface CreateAccountInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.CreateAccountInput"
    readonly label: string
  }

  /**
   * Create a producer's WIRE account (name = `account`, which for a
   * producer equals its durable `label` handle; owner = active = the
   * operator's `wire` public key from `ctx.keyStore`). Requires the operator's
   * materialize step to have run first. OPP operators (batch / underwriter) use
   * {@link planSponsoredAccountCreation} instead — their accounts are
   * node-owner-created with generated names.
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

  /** Named runner — ONE `newaccount`, keyed by the stored operator's `wire` key. */
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

  // ── Step: node-owner-sponsored account creation (roa::newuser, write) ─────

  /** Input for {@link planSponsoredAccountCreation}. */
  export interface SponsoredAccountCreationInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.SponsoredAccountCreationInput"
    readonly label: string
  }

  /**
   * Create an OPP operator's WIRE account via the bootstrap node owner:
   * `sysio.roa::newuser({creator: wireno, nonce: <fresh>, pubkey: <operator K1>})`
   * signed `[wireno@active]`. The nonce is a SINGLE-USE token minted per call
   * ({@link newSponsorNonce}) — never the operator's durable handle: `sysio.roa`
   * uses it as entropy for the generated name and hard-rejects reuse by the same
   * creator. The chain generates a `<nodeOwner>.<suffix>` name and records the
   * `(creator, nonce) → username` sponsor mapping; the runner reads it back BY
   * THE MINTED NONCE and adopts it into the operator's `account` (the
   * durable `label` handle is never overwritten). NOT re-entrant across
   * processes — `create` always starts from a wiped directory against a fresh
   * chain, and a `ClusterBuildStep` runs exactly once per build. Requires the
   * operator's materialize step to have run first.
   */
  export function planSponsoredAccountCreation<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, SponsoredAccountCreationInput> {
    return ClusterBuildStep.create<C, SponsoredAccountCreationInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireOperatorProvisioningTool.SponsoredAccountCreationInput",
        label
      },
      runSponsoredAccountCreation
    )
  }

  /** Named runner — ONE `roa::newuser` as the node owner, then adopt the generated name. */
  export async function runSponsoredAccountCreation<C extends ClusterBuildContext>(
    ctx: C,
    input: SponsoredAccountCreationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.label),
      roa = ctx.wire.getSysioContract(SysioContracts.SysioContractName.roa),
      nonce = newSponsorNonce()
    await roa.actions.newuser.invoke(
      {
        creator: Constants.BOOTSTRAP_NODE_OWNER,
        nonce,
        pubkey: operator.wire.publicKey
      },
      {
        authorization: [
          { actor: Constants.BOOTSTRAP_NODE_OWNER, permission: "active" }
        ]
      }
    )
    const account = await readSponsoredUsername(ctx, nonce)
    Assert.ok(
      account != null,
      `sponsoredAccountCreation: no sponsors row for nonce "${nonce}" under ${Constants.BOOTSTRAP_NODE_OWNER} after newuser`
    )
    // The read-back lands on `account` — `label` keeps the durable handle
    // the keystore is keyed by, so this never re-keys the store.
    ctx.keyStore.setOperator({ ...operator, account })
    log.info(
      `[provision] ${input.label} — node-owner-created WIRE account ${account} (sponsor ${Constants.BOOTSTRAP_NODE_OWNER})`
    )
  }

  /**
   * The generated username the node owner's `sponsors` table records for
   * `nonce` (typed KV read, scoped to the sponsoring node owner), or nothing
   * when no row carries that nonce. Called only AFTER `newuser` has landed with
   * finality, so the table provably exists and a read failure is a REAL failure
   * — it propagates rather than being tolerated as "no row yet".
   *
   * @param ctx - The build context.
   * @param nonce - The single-use nonce the row was created under.
   * @returns The generated `<nodeOwner>.<suffix>` account name.
   */
  async function readSponsoredUsername(
    ctx: ClusterBuildContext,
    nonce: string
  ): Promise<string> {
    // The sponsors roster is one row per provisioned OPP operator; the explicit
    // limit keeps the read whole as the roster grows toward its ceiling.
    const { rows } = await ctx.wire
      .getSysioContract(SysioContracts.SysioContractName.roa)
      .tables.sponsors.query({
        scope: Constants.BOOTSTRAP_NODE_OWNER,
        limit: SponsorsRowLimit
      })
    return rows.find(row => row.nonce === nonce)?.username
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
   * label is the operator's `account`, resolved from `ctx.keyStore` at
   * RUN time — it is the sponsored-creation step's generated name, unknown when
   * the plan is built.
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

  /** A single ETH transfer from anvil's deployer to the operator's wallet. */
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

  /** Named runner — ONE `sendTransaction` from anvil #0 to the operator wallet. */
  export async function runEthereumFunding<C extends ClusterBuildContext>(
    ctx: C,
    input: FundEthereumInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.label)
    const { signer } = ctx.ethereum.wallet
    // Every operator funds from the SAME anvil signer while the operator phases
    // run in PARALLEL, so this write needs two things, not one.
    //
    // The nonce is PINNED from the shared per-address counter — the same
    // counter every other ETH write in the harness draws from. Letting ethers
    // derive it instead means a `getTransactionCount(…, "pending")` round-trip,
    // which lags un-mined submissions: measured 2026-08-10, nonce 157 was handed
    // to FOUR concurrent sends and three were rejected `nonce has already been
    // used`. The counter increments synchronously, so distinct callers cannot
    // collide even if they overlap.
    //
    // The serialize() queue stays because the counter's contract requires it:
    // a pinned nonce is only valid if every earlier submission actually landed,
    // so the receipt wait belongs INSIDE the critical section.
    await serialize(EthereumFundingQueueKey, async () => {
      const nonce = await resolveLatestNonce(signer)
      try {
        const response = await signer.sendTransaction({
          to: operator.ethereum.address,
          value: input.wei,
          nonce
        })
        await response.wait()
      } catch (error) {
        // The counter already advanced for a nonce that never landed. Re-seed
        // from the chain, or every later send sits above the chain's nonce and
        // waits in the mempool forever.
        clearNonceCache(await signer.getAddress())
        log.warn(
          `fund ${input.label} ETH wallet failed at nonce ${nonce}; nonce cache cleared: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        throw error
      }
    })
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
    // `operator.account` is the RESOLVED chain label (the
    // sponsored-creation step's generated name) — the link message +
    // `account@active` auth must carry it, never the durable handle.
    const operator = ctx.keyStore.assertOperator(input.label)
    if (input.chainKind === ChainKind.EVM) {
      const ethereumWallet = ethereumSigner(operator.ethereum, ctx.ethereum.provider)
      await AuthExLinkTool.createLink(ctx.wire, {
        chainKind: ChainKind.EVM,
        account: operator.account,
        privateKey: PrivateKey.from(operator.ethereum.privateKey),
        ethereumWallet
      })
      return
    }
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: input.chainKind,
      account: operator.account,
      privateKey: solanaSdkPrivateKey(operator.solana)
    })
  }
}
