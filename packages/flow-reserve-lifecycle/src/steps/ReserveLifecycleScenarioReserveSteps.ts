import Assert from "node:assert"
import { ethers } from "ethers"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildStep,
  EthereumCollateralTool,
  EthereumOutpostBootstrapper,
  Report,
  outputKey,
  requestEthereumSwap,
  contractView,
  resolveLatestNonce,
  swapUserOutputKey,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type EthereumReserveCreateArgs,
  type EthereumSwapRequest,
  type OutputKey,
  type ReserveManagerRequestSwapContract,
  type StepInput,
  ClusterConfigProvider
} from "@wireio/cluster-tool"
import { ReserveLifecycleScenarioConstants as Constants } from "../ReserveLifecycleScenarioConstants.js"

const { SysioContractAccount, SysioContractName } = SysioContracts

/**
 * Flow-local Step factories for the reserve-lifecycle WRITES: the two native
 * `ReserveManager.create_reserve` submissions (linked + unlinked creators),
 * the unlinked-creator gas funding, the depot `sysio.reserv::matchreserve`
 * escrow write, and the private↔public `requestSwap` probe. Every on-chain
 * WRITE is its own {@link ClusterBuildStep}; the ReserveManager binding +
 * wallet derivation are pure value helpers used INSIDE the runners, and
 * {@link readOutpostReserveStatus} is a free READ for verify steps.
 */
export namespace ReserveLifecycleScenarioReserveSteps {
  /**
   * The native reserve-create args — the ERC-20 struct from
   * `EthereumSwapTool` minus `creatorPubKey`, which each runner injects from
   * its signing wallet at run time (the contract verifies the compressed key
   * derives to `msg.sender`).
   */
  export type NativeReserveCreateArgs = Omit<
    EthereumReserveCreateArgs,
    "creatorPubKey"
  >

  /** The swap-probe args — `EthereumSwapRequest` minus the runtime recipient. */
  export type SwapProbeRequest = Omit<EthereumSwapRequest, "targetRecipient">

  /**
   * Structural surface of the `ReserveManager` members this flow binds: the
   * NATIVE positional `create_reserve` (the ERC-20 struct variants live on
   * `EthereumSwapTool`) and the `getReserve` local-record read.
   */
  export interface ReserveManagerNativeContract extends ethers.BaseContract {
    create_reserve: (
      tokenCode: bigint,
      reserveCode: bigint,
      externalTokenAmount: bigint,
      requestedWireAmount: bigint,
      connectorWeightBps: number,
      name: string,
      description: string,
      isPrivate: boolean,
      creatorPubKey: string,
      overrides: ethers.Overrides & { value: bigint }
    ) => Promise<ethers.ContractTransactionResponse>
    getReserve: (
      tokenCode: bigint,
      reserveCode: bigint
    ) => Promise<{ status: bigint }>
  }

  // ── cross-step output keys ─────────────────────────────────────────────────

  /** WIRE balances snapshotted immediately before the `matchreserve` push. */
  export interface WireCustodySnapshot {
    /** `sysio.reserv` custody balance (raw 9-dp base units). */
    readonly custody: bigint
    /** The matcher's balance (raw 9-dp base units). */
    readonly matcher: bigint
  }

  /**
   * Typed cross-step output key for the pre-match WIRE balance snapshot — the
   * custody-exact verify reads it back after the row flips ACTIVE.
   *
   * @returns A typed `OutputKey<WireCustodySnapshot>` for `ctx.outputs`.
   */
  export function wireCustodySnapshotKey(): OutputKey<WireCustodySnapshot> {
    return outputKey<WireCustodySnapshot>(
      "reserveLifecycleWireCustodySnapshot",
      "WIRE custody + matcher balances before matchreserve"
    )
  }

  /**
   * Typed cross-step output key for the unlinked creator's ETH balance right
   * before its `create_reserve` — the refund verify computes the floor
   * (`preCreate - gas allowance`) from it.
   *
   * @returns A typed `OutputKey<bigint>` for `ctx.outputs`.
   */
  export function unlinkedCreatorPreCreateBalanceKey(): OutputKey<bigint> {
    return outputKey<bigint>(
      "reserveLifecycleUnlinkedCreatorPreCreateBalance",
      "unlinked creator's wei balance before create_reserve"
    )
  }

  // ── value helpers (derivation / binding / reads — used INSIDE runners) ─────

  /**
   * The deterministic unlinked-creator wallet — one anvil HD slot past the
   * shared swap-user slot, funded for gas + escrow but NEVER authex-linked.
   *
   * @param ctx - The build context (supplies the Ethereum provider).
   * @returns The connected HD wallet.
   */
  export function unlinkedCreatorWallet<C extends ClusterBuildContext>(
    ctx: C
  ): ethers.HDNodeWallet {
    return ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(EthereumOutpostBootstrapper.AnvilMnemonic),
      `${EthereumOutpostBootstrapper.DerivationPath}${Constants.NoLinkCreatorHdIndex}`
    ).connect(ctx.ethereum.provider)
  }

  /**
   * Resolve the `ReserveManager` contract from the run's deploy artifacts,
   * bound to `signer`. Address + ABI via `EthereumCollateralTool`'s outpost
   * artifact loaders.
   *
   * @param ctx - The build context (supplies `config.ethereumPath`).
   * @param signer - The signer to bind (any signer works for reads).
   * @returns The bound contract, typed to the surfaces this flow uses.
   */
  export function loadReserveManager<C extends ClusterBuildContext>(
    ctx: C,
    signer: ethers.Signer
  ): ReserveManagerNativeContract & ReserveManagerRequestSwapContract {
    const address = EthereumCollateralTool.loadOutpostAddresses(
      ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
    )[Constants.ReserveManagerContractName]
    Assert.ok(
      address != null && /^0x[0-9a-fA-F]{40}$/.test(address),
      `ReserveLifecycleScenarioReserveSteps: ReserveManager not in outpost-addrs.json (got ${address})`
    )
    const abi = EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      Constants.ReserveManagerContractName
    )
    return contractView<
      ReserveManagerNativeContract & ReserveManagerRequestSwapContract
    >(address, abi, signer)
  }

  /**
   * READ the outpost-LOCAL reserve record status (the `ReserveManager`
   * storage mirror, `EthereumLocalReserveStatus`-valued). A read — executes
   * freely inside verify steps.
   *
   * @param ctx - The build context.
   * @param tokenCode - The reserve's token slug (uint64 as bigint).
   * @param reserveCode - The reserve's own slug (uint64 as bigint).
   * @returns The record's numeric local status.
   */
  export async function readOutpostReserveStatus<C extends ClusterBuildContext>(
    ctx: C,
    tokenCode: bigint,
    reserveCode: bigint
  ): Promise<number> {
    const reserveManager = loadReserveManager(ctx, ctx.ethereum.wallet.signer)
    const record = await reserveManager.getReserve(tokenCode, reserveCode)
    return Number(record.status)
  }

  /** ONE native `create_reserve` write from `wallet`, escrow riding `msg.value`. */
  async function sendCreateReserve<C extends ClusterBuildContext>(
    ctx: C,
    wallet: ethers.HDNodeWallet,
    create: EthereumReserveCreateArgs
  ): Promise<void> {
    Assert.ok(
      create.externalTokenAmount > 0n,
      "ReserveLifecycleScenarioReserveSteps: externalTokenAmount must be > 0"
    )
    const reserveManager = loadReserveManager(ctx, wallet)
    const nonce = await resolveLatestNonce(reserveManager)
    const response = await reserveManager.create_reserve(
      create.tokenCode,
      create.reserveCode,
      create.externalTokenAmount,
      create.requestedWireAmount,
      create.connectorWeightBps,
      create.name,
      create.description,
      create.isPrivate,
      create.creatorPubKey,
      { value: create.externalTokenAmount, nonce }
    )
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `ReserveLifecycleScenarioReserveSteps: create_reserve reverted (status=${receipt?.status ?? "null"})`
    )
  }

  // ── Step: create_reserve from the LINKED creator (the swap-user wallet) ───

  /** Input for {@link planCreateReserve} — one linked-creator `create_reserve` write. */
  export interface CreateReserveInput extends StepInput {
    readonly kind: "ReserveLifecycleScenarioReserveSteps.CreateReserveInput"
    /** The create args; the runner injects the creator's compressed pubkey. */
    readonly create: NativeReserveCreateArgs
  }

  /**
   * A single native `create_reserve` write signed by the AUTHEX-LINKED
   * creator (the swap-user wallet from `ctx.outputs`). The contract escrows
   * `externalTokenAmount` wei and queues the RESERVE_CREATE attestation.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param create - The create args (pubkey injected at run time).
   * @returns The definition step.
   */
  export function planCreateReserve<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    create: NativeReserveCreateArgs
  ): ClusterBuildStep<C, CreateReserveInput> {
    return ClusterBuildStep.create<C, CreateReserveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "ReserveLifecycleScenarioReserveSteps.CreateReserveInput",
        create
      },
      runCreateReserve
    )
  }

  /** Named runner — ONE `create_reserve` write from the linked swap-user wallet. */
  export async function runCreateReserve<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateReserveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const wallet = ctx.outputs.assert(swapUserOutputKey()).ethereumWallet
    await sendCreateReserve(ctx, wallet, {
      ...input.create,
      creatorPubKey: wallet.signingKey.compressedPublicKey
    })
  }

  // ── Step: create_reserve from the UNLINKED creator (new HD wallet) ──────

  /** Input for {@link planCreateReserveUnlinked} — one unlinked-creator create write. */
  export interface CreateReserveUnlinkedInput extends StepInput {
    readonly kind: "ReserveLifecycleScenarioReserveSteps.CreateReserveUnlinkedInput"
    /** The create args; the runner injects the creator's compressed pubkey. */
    readonly create: NativeReserveCreateArgs
  }

  /**
   * A single native `create_reserve` write signed by the NEVER-LINKED creator
   * wallet ({@link unlinkedCreatorWallet}). The runner snapshots the wallet's
   * pre-create balance into `ctx.outputs`
   * ({@link unlinkedCreatorPreCreateBalanceKey}) so the refund verify can
   * compute its floor. The depot cancels the create back
   * (RESERVE_CREATE_CANCELLED) because the creator key has no authex link.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param create - The create args (pubkey injected at run time).
   * @returns The definition step.
   */
  export function planCreateReserveUnlinked<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    create: NativeReserveCreateArgs
  ): ClusterBuildStep<C, CreateReserveUnlinkedInput> {
    return ClusterBuildStep.create<C, CreateReserveUnlinkedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "ReserveLifecycleScenarioReserveSteps.CreateReserveUnlinkedInput",
        create
      },
      runCreateReserveUnlinked
    )
  }

  /** Named runner — snapshot the pre-create balance, then ONE `create_reserve` write. */
  export async function runCreateReserveUnlinked<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateReserveUnlinkedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const wallet = unlinkedCreatorWallet(ctx)
    const preCreateBalance = await ctx.ethereum.getBalance(wallet.address)
    ctx.outputs.set(unlinkedCreatorPreCreateBalanceKey(), preCreateBalance)
    await sendCreateReserve(ctx, wallet, {
      ...input.create,
      creatorPubKey: wallet.signingKey.compressedPublicKey
    })
  }

  // ── Step: fund the unlinked creator wallet (gas + escrow headroom) ────────

  /** Input for {@link planFundUnlinkedCreator} — one wei transfer write. */
  export interface FundUnlinkedCreatorInput extends StepInput {
    readonly kind: "ReserveLifecycleScenarioReserveSteps.FundUnlinkedCreatorInput"
    /** Wei sent from anvil signer 0 to the unlinked creator wallet. */
    readonly amountWei: bigint
  }

  /**
   * A single wei transfer from the harness's default anvil signer to the
   * unlinked creator wallet, covering its create escrow + gas.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param amountWei - Wei to seed the wallet with.
   * @returns The definition step.
   */
  export function planFundUnlinkedCreator<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    amountWei: bigint
  ): ClusterBuildStep<C, FundUnlinkedCreatorInput> {
    return ClusterBuildStep.create<C, FundUnlinkedCreatorInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "ReserveLifecycleScenarioReserveSteps.FundUnlinkedCreatorInput",
        amountWei
      },
      runFundUnlinkedCreator
    )
  }

  /** Named runner — ONE `sendTransaction` write from anvil signer 0. */
  export async function runFundUnlinkedCreator<C extends ClusterBuildContext>(
    ctx: C,
    input: FundUnlinkedCreatorInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.amountWei > 0n,
      "ReserveLifecycleScenarioReserveSteps: funding amountWei must be > 0"
    )
    const response = await ctx.ethereum.wallet.signer.sendTransaction({
      to: unlinkedCreatorWallet(ctx).address,
      value: input.amountWei
    })
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `ReserveLifecycleScenarioReserveSteps: funding tx reverted (status=${receipt?.status ?? "null"})`
    )
  }

  // ── Step: matchreserve (the depot escrow write that activates the row) ────

  /** Input for {@link planMatchReserve} — one `sysio.reserv::matchreserve` write. */
  export interface MatchReserveInput extends StepInput {
    readonly kind: "ReserveLifecycleScenarioReserveSteps.MatchReserveInput"
    /** The reserve's chain slug value. */
    readonly chainCode: number
    /** The reserve's token slug value. */
    readonly tokenCode: number
    /** The reserve's own slug value. */
    readonly reserveCode: number
    /** The WIRE account escrowing the match (must be authex-linked to the creator key). */
    readonly matcher: string
    /** Raw WIRE base units — must equal the row's `requested_wire_amount` exactly. */
    readonly wireAmount: bigint
  }

  /**
   * A single `sysio.reserv::matchreserve` write authorized by the matcher.
   * The runner snapshots the `sysio.reserv` custody + matcher WIRE balances
   * into `ctx.outputs` ({@link wireCustodySnapshotKey}) immediately before
   * the push so the custody-exact verify can assert the transfer amounts.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param chainCode - The reserve's chain slug value.
   * @param tokenCode - The reserve's token slug value.
   * @param reserveCode - The reserve's own slug value.
   * @param matcher - The authex-linked WIRE matcher account.
   * @param wireAmount - Raw WIRE base units to escrow (exact match required).
   * @returns The definition step.
   */
  export function planMatchReserve<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainCode: number,
    tokenCode: number,
    reserveCode: number,
    matcher: string,
    wireAmount: bigint
  ): ClusterBuildStep<C, MatchReserveInput> {
    return ClusterBuildStep.create<C, MatchReserveInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "ReserveLifecycleScenarioReserveSteps.MatchReserveInput",
        chainCode,
        tokenCode,
        reserveCode,
        matcher,
        wireAmount
      },
      runMatchReserve
    )
  }

  /** Named runner — snapshot balances, then ONE `matchreserve` write. */
  export async function runMatchReserve<C extends ClusterBuildContext>(
    ctx: C,
    input: MatchReserveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const custody = await ctx.wire.getWireBalance(
      SysioContractAccount[SysioContractName.reserv]
    )
    const matcher = await ctx.wire.getWireBalance(input.matcher)
    Assert.ok(
      matcher >= input.wireAmount,
      `ReserveLifecycleScenarioReserveSteps: matcher ${input.matcher} holds ${matcher}, needs ${input.wireAmount}`
    )
    ctx.outputs.set(wireCustodySnapshotKey(), { custody, matcher })
    await ctx.wire
      .getSysioContract(SysioContractName.reserv)
      .actions.matchreserve.invoke(
        {
          chain_code: { value: input.chainCode },
          token_code: { value: input.tokenCode },
          reserve_code: { value: input.reserveCode },
          matcher: input.matcher,
          wire_amount: Number(input.wireAmount)
        },
        { authorization: [{ actor: input.matcher, permission: "active" }] }
      )
  }

  // ── Step: the private↔public swap probe (rejected by the privacy gate) ────

  /** Input for {@link planRequestSwapProbe} — one `requestSwap` write. */
  export interface RequestSwapProbeInput extends StepInput {
    readonly kind: "ReserveLifecycleScenarioReserveSteps.RequestSwapProbeInput"
    /** The swap args; the runner injects the swap user's SOL recipient bytes. */
    readonly request: SwapProbeRequest
  }

  /**
   * A single `ReserveManager.requestSwap` write from the swap-user wallet,
   * sourcing the PRIVATE reserve against a PUBLIC counterpart. The outpost
   * accepts the tx (escrow + SWAP_REQUEST attestation); the DEPOT's privacy
   * gate then rejects the pairing with a SWAP_REVERT and never opens a UWREQ.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param request - The swap args (recipient injected at run time).
   * @returns The definition step.
   */
  export function planRequestSwapProbe<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    request: SwapProbeRequest
  ): ClusterBuildStep<C, RequestSwapProbeInput> {
    return ClusterBuildStep.create<C, RequestSwapProbeInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "ReserveLifecycleScenarioReserveSteps.RequestSwapProbeInput",
        request
      },
      runRequestSwapProbe
    )
  }

  /** Named runner — ONE `requestSwap` write via the harness's `requestEthereumSwap`. */
  export async function runRequestSwapProbe<C extends ClusterBuildContext>(
    ctx: C,
    input: RequestSwapProbeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const reserveManager = loadReserveManager(ctx, swapUser.ethereumWallet)
    const result = await requestEthereumSwap(reserveManager, {
      ...input.request,
      targetRecipient: swapUser.solanaPublicKeyBytes
    })
    Assert.ok(
      result.transactionHash.length > 0,
      "ReserveLifecycleScenarioReserveSteps: requestSwap returned no transaction hash"
    )
  }
}
