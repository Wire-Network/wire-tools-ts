/**
 * WireOperatorProvisioningTool — THE operator-provisioning mechanism. Every
 * operator — producer, batch operator, underwriter, or a flow's extra account —
 * is provisioned through {@link planOperatorAccountProvisioning}, which RETURNS a
 * {@link ClusterBuildPhaseGroup} with one {@link ClusterBuildPhase} per operator
 * (per the orchestration model: every WRITE is its own {@link ClusterBuildStep}
 * so the `Report` records it).
 *
 * Each Phase materializes the operator's type-appropriate keys and accumulates
 * its {@link OperatorAccount} into THE single {@link ClusterKeyStore}
 * (`ctx.keyStore`) — the one place keys are accessed from — then runs the
 * on-chain writes:
 *
 * - **producer**: materialize (node-shared K1+BLS from the store's node sets) →
 *   create the WIRE account with that K1.
 * - **batch operator / underwriter**: materialize (UNIQUE generated K1 + EM + ED;
 *   the K1 imported into the kiod wallet so `account@active` signs) → create the
 *   WIRE account with that K1 → (optional) fund ETH / airdrop SOL → authex-link
 *   both chains → `opreg::regoperator`.
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
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { abiEnumValue } from "../../utils/enumUtils.js"
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
import { OperatorSteps } from "../../orchestration/steps/OperatorSteps.js"
import { EthereumOutpostBootstrapper } from "../../orchestration/ethereum/EthereumOutpostBootstrapper.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import {
  ethereumSigner,
  solanaKeypair,
  solanaSdkPrivateKey
} from "../../utils/keyPairUtils.js"
import { AuthExLinkTool } from "../all/AuthExLinkTool.js"

const log = getLogger(__filename)

export namespace WireOperatorProvisioningTool {
  /** Default wei seeded into a flow operator's ETH wallet (covers a deposit + gas). */
  export const DefaultEthereumFundWei = 10n ** 18n // 1 ETH
  /** Default lamports airdropped to a flow operator's SOL keypair. */
  export const DefaultSolanaAirdropLamports = 5n * BigInt(LAMPORTS_PER_SOL)
  /** Creator account for provisioned operator accounts. */
  const AccountCreator = "sysio"

  /** One operator to provision — `type` drives which keys + steps its Phase runs. */
  export interface OperatorProvisioningSpec {
    /** WIRE account name to provision. */
    readonly account: string
    /** The operator's proto {@link OperatorType}. */
    readonly type: OperatorType
    /** Producer: index of the producer NODE whose K1+BLS this account shares. */
    readonly producerNodeIndex?: number
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
          `provision ${spec.account}: unsupported operator type ${OperatorType[spec.type] ?? spec.type}`
        )
      })
  }

  /** A producer's Phase: materialize its (node-shared) identity, then create its account. */
  function planProvisionProducerPhase<C extends ClusterBuildContext>(
    group: ClusterBuildParent<C>,
    spec: OperatorProvisioningSpec,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const { account, producerNodeIndex } = spec
    Assert.ok(
      producerNodeIndex != null,
      `provision producer ${account}: producerNodeIndex is required`
    )
    return ClusterBuildPhase.create<C>(group, `Provision ${account}`, `provision producer ${account}`, [
      planProducerMaterialization<C>(
        Report.Actor.Producer,
        `${account}-identity`,
        `materialize producer ${account} identity from node ${producerNodeIndex}`,
        options,
        account,
        producerNodeIndex
      ),
      planAccountCreation<C>(
        Report.Actor.Producer,
        `${account}-account`,
        `create WIRE account ${account}`,
        options,
        account
      )
    ])
  }

  /**
   * A batch-operator / underwriter Phase: materialize keys → create account →
   * (optional) fund ETH / airdrop SOL → authex-link both chains → register.
   * Funding steps are included only when the spec supplies an amount (bootstrap
   * ops skip them; deposit flows opt in).
   */
  function planProvisionOppOperatorPhase<C extends ClusterBuildContext>(
    group: ClusterBuildParent<C>,
    spec: OperatorProvisioningSpec,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const {
        account,
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
      `provision operator ${account}: ethereumHdIndex is required`
    )
    return ClusterBuildPhase.create<C>(group, `Provision ${account}`, `provision operator ${account}`, [
      planIdentityMaterialization<C>(
        actor,
        `${account}-identity`,
        `generate ${account} WIRE + ETH + SOL identity`,
        options,
        account,
        type,
        ethereumHdIndex
      ),
      planAccountCreation<C>(
        actor,
        `${account}-account`,
        `create WIRE account ${account}`,
        options,
        account
      ),
      ...(fundEthereumWei != null && !isExternalOutpost
        ? [
            planEthereumFunding<C>(
              actor,
              `${account}-fund-ethereum`,
              `fund ${account} ETH wallet`,
              options,
              account,
              fundEthereumWei
            )
          ]
        : []),
      ...(airdropSolanaLamports != null && !isExternalOutpost
        ? [
            planSolanaAirdrop<C>(
              actor,
              `${account}-airdrop-solana`,
              `airdrop SOL to ${account}`,
              options,
              account,
              airdropSolanaLamports
            )
          ]
        : []),
      planAuthexLink<C>(
        actor,
        `${account}-authex-ethereum`,
        `authex-link ${account} on Ethereum`,
        options,
        account,
        ChainKind.EVM
      ),
      planAuthexLink<C>(
        actor,
        `${account}-authex-solana`,
        `authex-link ${account} on Solana`,
        options,
        account,
        ChainKind.SVM
      ),
      OperatorSteps.planRegister<C>(
        actor,
        `${account}-register`,
        `register operator ${account}`,
        options,
        {
          account,
          // proto OperatorType + the ABI mirror share numeric values —
          // resolved through the checked bridge.
          type: abiEnumValue(SysioContracts.SysioOpregOperatortype, type),
          is_bootstrapped: isBootstrapped ?? true
        }
      )
    ])
  }

  // ── Step: materialize an OPP operator's identity (keys → store + wallet) ──

  /** Input for {@link planIdentityMaterialization}. */
  export interface MaterializeIdentityInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.MaterializeIdentityInput"
    readonly account: string
    readonly type: OperatorType
    readonly ethereumHdIndex: number
  }

  /**
   * Generate the operator's UNIQUE WIRE K1 (its account controller — imported
   * into the kiod wallet so `account@active` can sign), plus its ETH (EM) + SOL
   * (ED) keys, all via the {@link KeyGenerator} facade — then accumulate the
   * {@link OperatorAccount} into `ctx.keyStore`.
   */
  export function planIdentityMaterialization<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
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
        account,
        type,
        ethereumHdIndex
      },
      runIdentityMaterialization
    )
  }

  /** Named runner — generate K1/ED/EM, import the K1 into kiod, store the account. */
  export async function runIdentityMaterialization<C extends ClusterBuildContext>(
    ctx: C,
    input: MaterializeIdentityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.account.length > 0 && input.account.length <= 12,
      `materializeIdentity: account "${input.account}" must be 1..12 chars`
    )
    const keyContext = KeyGenerator.context(
      ctx.config.executables.clio,
      ctx.config.buildPath,
      EthereumOutpostBootstrapper.AnvilMnemonic
    )
    const [wire, solana, ethereum] = await Promise.all([
      KeyGenerator.create(KeyType.K1, keyContext, {
        purpose: `operator ${input.account} — WIRE account key (K1)`
      }),
      KeyGenerator.create(KeyType.ED, keyContext, {
        purpose: `operator ${input.account} — solana outpost key (ED)`
      }),
      KeyGenerator.create(KeyType.EM, keyContext, {
        ethereumHdIndex: input.ethereumHdIndex,
        purpose: `operator ${input.account} — ethereum outpost key (EM)`
      })
    ])
    // Import the operator's unique wire key so kiod can sign `account@active`
    // (authex links, registration, and any operator-signed flow actions).
    const wallet = await ctx.wire.wallet.getOrCreate()
    await wallet.addPrivateKey(wire.privateKey)
    ctx.keyStore.setOperator({
      account: input.account,
      type: input.type,
      wire,
      ethereum,
      solana
    })
    log.info(
      `[provision] ${input.account} — WIRE ${wire.publicKey}, ETH ${ethereum.address} (hd=${input.ethereumHdIndex}), SOL ${solana.publicKey}`
    )
  }

  // ── Step: materialize a producer's identity (from its node's shared keys) ──

  /** Input for {@link planProducerMaterialization}. */
  export interface MaterializeProducerInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.MaterializeProducerInput"
    readonly account: string
    readonly producerNodeIndex: number
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
    account: string,
    producerNodeIndex: number
  ): ClusterBuildStep<C, MaterializeProducerInput> {
    return ClusterBuildStep.create<C, MaterializeProducerInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireOperatorProvisioningTool.MaterializeProducerInput",
        account,
        producerNodeIndex
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
    ctx.keyStore.setOperator({
      account: input.account,
      type: OperatorType.PRODUCER,
      wire: nodeKeys.keys.k1,
      bls: nodeKeys.keys.bls
    })
    // Descriptive payload only — the full pairs live under the step that
    // GENERATED them (generate-keys); here we just say whose set this is.
    StepExtraRecorder.note(
      `producer ${input.account} assumes node_${String(input.producerNodeIndex).padStart(2, "0")}'s signing set`,
      {
        account: input.account,
        wirePublicKey: nodeKeys.keys.k1.publicKey,
        blsPublicKey: nodeKeys.keys.bls.publicKey
      }
    )
    log.info(
      `[provision] producer ${input.account} — node ${input.producerNodeIndex} (K1 ${nodeKeys.keys.k1.publicKey})`
    )
  }

  // ── Step: create the operator's WIRE account with ITS OWN key (write) ─────

  /** Input for {@link planAccountCreation}. */
  export interface CreateAccountInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.CreateAccountInput"
    readonly account: string
  }

  /**
   * Create the operator's WIRE account (owner = active = the operator's `wire`
   * public key from `ctx.keyStore`). Requires the operator's materialize step to
   * have run first.
   */
  export function planAccountCreation<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, CreateAccountInput> {
    return ClusterBuildStep.create<C, CreateAccountInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireOperatorProvisioningTool.CreateAccountInput", account },
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
    const operator = ctx.keyStore.assertOperator(input.account)
    await ctx.wire.createAccount(
      AccountCreator,
      operator.account,
      operator.wire.publicKey,
      operator.wire.publicKey
    )
  }

  // ── Step: fund the operator's ETH wallet (write) ─────────────────────────

  /** Input for {@link planEthereumFunding}. */
  export interface FundEthereumInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.FundEthereumInput"
    readonly account: string
    readonly wei: bigint
  }

  /** A single ETH transfer from anvil's deployer to the operator's wallet. */
  export function planEthereumFunding<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    wei: bigint
  ): ClusterBuildStep<C, FundEthereumInput> {
    return ClusterBuildStep.create<C, FundEthereumInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireOperatorProvisioningTool.FundEthereumInput", account, wei },
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
    const operator = ctx.keyStore.assertOperator(input.account)
    const response = await ctx.ethereum.wallet.signer.sendTransaction({
      to: operator.ethereum.address,
      value: input.wei
    })
    await response.wait()
  }

  // ── Step: airdrop SOL to the operator keypair (write) ────────────────────

  /** Input for {@link planSolanaAirdrop}. */
  export interface AirdropSolanaInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.AirdropSolanaInput"
    readonly account: string
    readonly lamports: bigint
  }

  /** A single `requestAirdrop` to the operator's SOL keypair. */
  export function planSolanaAirdrop<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    lamports: bigint
  ): ClusterBuildStep<C, AirdropSolanaInput> {
    return ClusterBuildStep.create<C, AirdropSolanaInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireOperatorProvisioningTool.AirdropSolanaInput", account, lamports },
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
    const operator = ctx.keyStore.assertOperator(input.account)
    const signature = await ctx.solana.connection.requestAirdrop(
      solanaKeypair(operator.solana).publicKey,
      Number(input.lamports)
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `provision airdrop ${input.account}`
    )
  }

  // ── Step: authex-link the operator's chain key (write) ───────────────────

  /** Input for {@link planAuthexLink}. */
  export interface AuthexLinkInput extends StepInput {
    readonly kind: "WireOperatorProvisioningTool.AuthexLinkInput"
    readonly account: string
    readonly chainKind: ChainKind
  }

  /** A single `sysio.authex::createlink` write for the operator on one chain. */
  export function planAuthexLink<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    chainKind: ChainKind
  ): ClusterBuildStep<C, AuthexLinkInput> {
    return ClusterBuildStep.create<C, AuthexLinkInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireOperatorProvisioningTool.AuthexLinkInput", account, chainKind },
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
    const operator = ctx.keyStore.assertOperator(input.account)
    if (input.chainKind === ChainKind.EVM) {
      const ethereumWallet = ethereumSigner(operator.ethereum, ctx.ethereum.provider)
      await AuthExLinkTool.createLink(ctx.wire, {
        chainKind: ChainKind.EVM,
        account: input.account,
        privateKey: PrivateKey.from(operator.ethereum.privateKey),
        ethereumWallet
      })
      return
    }
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: input.chainKind,
      account: input.account,
      privateKey: solanaSdkPrivateKey(operator.solana)
    })
  }
}
