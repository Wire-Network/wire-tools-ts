/**
 * EthereumSyndicationTool — Step factories for the Ethereum outpost's
 * syndication surface (`SyndicationPool`) and the liqETH writes that feed it.
 * Every on-chain WRITE is its OWN {@link ClusterBuildStep} so the `Report`
 * records it:
 *
 * - {@link EthereumSyndicationTool.planDepositLiqEth} — ETH → liqETH through
 *   `DepositManager.deposit`;
 * - {@link EthereumSyndicationTool.planApproveLiqEth} — the liqETH allowance
 *   `SyndicationPool.syndicate` draws on;
 * - {@link EthereumSyndicationTool.planSyndicate} — the holder syndicating into
 *   the pool, which queues `SYNDICATE_LIQ`;
 * - {@link EthereumSyndicationTool.planDonateToPool} — a plain liqETH transfer
 *   into the pool, custody the depot never credited;
 * - {@link EthereumSyndicationTool.planSetPaused} — the emergency stop, signed
 *   by the panic account;
 * - {@link EthereumSyndicationTool.planPayPendingDesyndication} — the
 *   permissionless crank that pays a `DESYNDICATE_LIQ` the pool stored.
 *
 * A holder is an anvil HD account, named by its index (the harness's end-user
 * convention — `SwapUserIdentities`, the flow constants). ABIs come from the
 * run's `<ethereumPath>/artifacts/contracts/…` and addresses from this
 * cluster's deploy-artifact files, both resolved inside the runners; each
 * runner encodes its ONE call through the request builders below, which are
 * pure and therefore what the unit tests check.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import { ethers } from "ethers"
import { SlugName } from "@wireio/sdk-core"

import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import { EthereumOutpostBootstrapper } from "../../orchestration/ethereum/EthereumOutpostBootstrapper.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"
import {
  loadOutpostContract,
  resolveLatestNonce
} from "../../utils/ethereumUtils.js"

export namespace EthereumSyndicationTool {
  /** `outpost-addrs.json` key + artifact basename of the syndication pool. */
  export const SyndicationPoolContractName = "SyndicationPool"
  /** Artifact dir segments of `SyndicationPool` under `artifacts/contracts`. */
  export const SyndicationPoolArtifactSubpath = ["outpost"] as const
  /** `liqeth-addrs.json` key + artifact basename of the liqETH deposit entry point. */
  export const DepositManagerContractName = "DepositManager"
  /**
   * Artifact dir segments of `DepositManager`: the deploy resolves the contract
   * NAME `DepositManager`, which is the one in `contracts/liqEth/v1/` (the
   * top-level `DepositManager.sol` declares `DepositManagerV2`).
   */
  export const DepositManagerArtifactSubpath = ["liqEth", "v1"] as const
  /**
   * `liqeth-addrs.json` key + artifact basename of the liqETH token — the
   * address `deployLocal.ts` hands the outpost deploy as its `LiqEth`.
   */
  export const LiqEthTokenContractName = "LiqEthToken"
  /**
   * Artifact dir segments of `LiqEthToken`: the deploy resolves the contract
   * NAME `LiqEthToken`, declared in `contracts/liqEth/v1/liqEth.sol` (the
   * top-level `liqEth.sol` declares `LiqEthTokenV2`).
   */
  export const LiqEthTokenArtifactSubpath = ["liqEth", "v1"] as const
  /** Basename of the Solidity file that declares `LiqEthToken`. */
  export const LiqEthTokenSourceName = "liqEth"
  /**
   * `outpost-addrs.json` key + artifact basename of the outpost's access
   * manager (an OpenZeppelin `AccessManagerUpgradeable`), the pool's
   * `authority()`.
   */
  export const OutpostManagerAuthorityContractName = "OutpostManagerAuthority"
  /** Artifact dir segments of `OutpostManagerAuthority`. */
  export const OutpostManagerAuthorityArtifactSubpath = ["outpost"] as const
  /** The depot codename of the liq token the pool custodies. */
  export const LiqEthTokenCodename = "LIQETH"
  /** liqETH's chain-native decimals — the pool's `liqTokenPrecision`. */
  export const LiqEthTokenPrecision = 18
  /** Confirmations every write waits for. */
  export const Confirmations = 1

  /** `SyndicationPool` functions the tool encodes, by ABI name. */
  export enum PoolFunction {
    syndicate = "syndicate",
    initializeSyndication = "initializeSyndication",
    pause = "pause",
    unpause = "unpause",
    payPendingDesyndication = "payPendingDesyndication"
  }

  /** ERC-20 functions the tool encodes on the liqETH token, by ABI name. */
  export enum LiqEthFunction {
    approve = "approve",
    transfer = "transfer"
  }

  /** `DepositManager` functions the tool encodes, by ABI name. */
  export enum DepositManagerFunction {
    deposit = "deposit"
  }

  /**
   * Why the pool stored a depot release instead of paying it —
   * `SyndicationPool.PendingPayoutReason`, whose ordinal the
   * `pendingDesyndications` getter returns. Values are appended only on the
   * contract.
   *
   * The two outposts' reasons differ per chain: this is Ethereum's set; the
   * Solana program's is `PendingPayoutReason` in `SolanaAnchorEnumTool`.
   */
  export enum PendingPayoutReason {
    OUTPOST_FROZEN = 0,
    SETTLEMENT_REFUSED = 1,
    CUSTODY_SHORTFALL = 2
  }

  /** The `SyndicationPool` reads this tool makes. */
  export interface SyndicationPoolView {
    paused(): Promise<boolean>
    poolBalanceDepot(): Promise<bigint>
    syndicatedPrincipal(): Promise<bigint>
    outpostChainCode(): Promise<bigint>
    pendingDesyndications(
      requestId: bigint
    ): Promise<[string, bigint, bigint]>
    maxSyndicationPerTransfer(): Promise<bigint>
    yieldDeadband(): Promise<bigint>
    liqTokenCode(): Promise<bigint>
    liqTokenPrecision(): Promise<bigint>
    authority(): Promise<string>
  }

  /** The liqETH token reads this tool makes. */
  export interface LiqEthTokenView {
    balanceOf(account: string): Promise<bigint>
  }

  /** The access-manager read the configuration check makes. */
  export interface AccessManagerView {
    canCall(
      caller: string,
      target: string,
      selector: string
    ): Promise<[boolean, bigint]>
  }

  /** One stored depot release (`SyndicationPool.pendingDesyndications`). */
  export interface PendingDesyndication {
    /** The payout address, derived from the holder's pubkey. */
    recipient: string
    /** Depot units (9 decimals) to pay. */
    depotAmount: bigint
    /** Why the release was stored. */
    reason: PendingPayoutReason
  }

  /** The pool configuration the deploy sets, as read back. */
  export interface PoolConfiguration {
    /** Largest single `syndicate` amount, in wei. */
    maxSyndicationPerTransfer: bigint
    /** Smallest reportable yield, in depot units. */
    yieldDeadband: bigint
    /** The depot token code the pool reports under. */
    liqTokenCode: bigint
    /** The liq token's chain-native decimals. */
    liqTokenPrecision: number
  }

  // ── value helpers (addresses, contracts, wallets — run INSIDE runners) ──

  /**
   * Read one of this cluster's deploy address maps (`outpost-addrs.json` /
   * `liqeth-addrs.json`).
   *
   * @param ctx - The build context (supplies the deploy-artifact dir).
   * @param file - The address-map file name.
   * @returns The contract-name → address map.
   * @throws If the file does not exist (the outpost was never deployed).
   */
  export function readDeployAddresses<C extends ClusterBuildContext>(
    ctx: C,
    file: string
  ): Record<string, string> {
    const path = Path.join(
      ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
      file
    )
    Assert.ok(
      Fs.existsSync(path),
      `EthereumSyndicationTool: ${path} is missing — the Ethereum outpost deploy must precede this`
    )
    return JSON.parse(Fs.readFileSync(path, "utf-8"))
  }

  /**
   * The deployed `SyndicationPool`, from this cluster's `outpost-addrs.json`
   * and the run's hardhat artifact.
   *
   * @param ctx - The build context.
   * @param runner - The signer (writes) or provider (reads) to bind.
   * @returns The pool contract.
   */
  export function loadSyndicationPool<C extends ClusterBuildContext>(
    ctx: C,
    runner: ethers.ContractRunner
  ): SyndicationPoolView & ethers.BaseContract {
    return loadOutpostContract<SyndicationPoolView>(
      ctx.config.ethereumPath,
      readDeployAddresses(
        ctx,
        EthereumOutpostBootstrapper.OutpostAddressesFile
      ),
      SyndicationPoolContractName,
      [...SyndicationPoolArtifactSubpath],
      runner
    )
  }

  /**
   * The deployed `DepositManager`, from this cluster's `liqeth-addrs.json` and
   * the run's hardhat artifact.
   *
   * @param ctx - The build context.
   * @param runner - The signer to bind.
   * @returns The deposit-manager contract.
   */
  export function loadDepositManager<C extends ClusterBuildContext>(
    ctx: C,
    runner: ethers.ContractRunner
  ): ethers.BaseContract {
    return loadOutpostContract<object>(
      ctx.config.ethereumPath,
      readDeployAddresses(
        ctx,
        EthereumOutpostBootstrapper.LiqEthAddressesFile
      ),
      DepositManagerContractName,
      [...DepositManagerArtifactSubpath],
      runner
    )
  }

  /**
   * The deployed liqETH token, from this cluster's `liqeth-addrs.json` and the
   * run's hardhat artifact.
   *
   * @param ctx - The build context.
   * @param runner - The signer (writes) or provider (reads) to bind.
   * @returns The token contract.
   */
  export function loadLiqEthToken<C extends ClusterBuildContext>(
    ctx: C,
    runner: ethers.ContractRunner
  ): LiqEthTokenView & ethers.BaseContract {
    return loadOutpostContract<LiqEthTokenView>(
      ctx.config.ethereumPath,
      readDeployAddresses(
        ctx,
        EthereumOutpostBootstrapper.LiqEthAddressesFile
      ),
      LiqEthTokenContractName,
      [...LiqEthTokenArtifactSubpath],
      runner,
      LiqEthTokenSourceName
    )
  }

  /**
   * The deployed outpost access manager, from this cluster's
   * `outpost-addrs.json` and the run's hardhat artifact.
   *
   * @param ctx - The build context.
   * @param runner - The provider to bind.
   * @returns The access-manager contract.
   */
  export function loadOutpostManagerAuthority<C extends ClusterBuildContext>(
    ctx: C,
    runner: ethers.ContractRunner
  ): AccessManagerView & ethers.BaseContract {
    return loadOutpostContract<AccessManagerView>(
      ctx.config.ethereumPath,
      readDeployAddresses(
        ctx,
        EthereumOutpostBootstrapper.OutpostAddressesFile
      ),
      OutpostManagerAuthorityContractName,
      [...OutpostManagerAuthorityArtifactSubpath],
      runner
    )
  }

  /**
   * The anvil HD wallet at `ethereumHdIndex`, connected to the run's provider.
   *
   * @param ctx - The build context (supplies the provider).
   * @param ethereumHdIndex - The HD account index.
   * @returns The connected wallet.
   */
  export function hdWallet<C extends ClusterBuildContext>(
    ctx: C,
    ethereumHdIndex: number
  ): ethers.HDNodeWallet {
    return EthereumOutpostBootstrapper.anvilWallet(ethereumHdIndex).connect(
      ctx.ethereum.provider
    )
  }

  /**
   * The 33-byte compressed secp256k1 public key of the anvil HD account at
   * `ethereumHdIndex`, as `0x` hex — the `compressedPubkey` `syndicate` needs,
   * which must derive to the sender. A pure value helper.
   *
   * @param ethereumHdIndex - The HD account index.
   * @returns The compressed key.
   */
  export function compressedPubkey(ethereumHdIndex: number): string {
    return ethers.SigningKey.computePublicKey(
      EthereumOutpostBootstrapper.anvilWallet(ethereumHdIndex).publicKey,
      true
    )
  }

  // ── request builders (pure — the ONE encoding the runners AND the tests use) ──

  /**
   * `DepositManager.deposit()` with `amountWei` attached.
   *
   * @param depositManager - The bound deposit manager.
   * @param amountWei - Wei to deposit.
   * @returns The transaction request.
   */
  export function depositLiqEthRequest(
    depositManager: ethers.BaseContract,
    amountWei: bigint
  ): ethers.TransactionRequest {
    return {
      to: depositManager.target,
      data: depositManager.interface.encodeFunctionData(
        DepositManagerFunction.deposit,
        []
      ),
      value: amountWei
    }
  }

  /**
   * `liqETH.approve(spender, amount)`.
   *
   * @param liqEth - The bound liqETH token.
   * @param spender - The address allowed to draw (the pool).
   * @param amount - The allowance, in wei.
   * @returns The transaction request.
   */
  export function approveLiqEthRequest(
    liqEth: ethers.BaseContract,
    spender: string,
    amount: bigint
  ): ethers.TransactionRequest {
    return {
      to: liqEth.target,
      data: liqEth.interface.encodeFunctionData(LiqEthFunction.approve, [
        spender,
        amount
      ])
    }
  }

  /**
   * `liqETH.transfer(pool, amount)` — a donation into the pool.
   *
   * @param liqEth - The bound liqETH token.
   * @param pool - The pool's address.
   * @param amount - Wei to transfer.
   * @returns The transaction request.
   */
  export function donateToPoolRequest(
    liqEth: ethers.BaseContract,
    pool: string,
    amount: bigint
  ): ethers.TransactionRequest {
    return {
      to: liqEth.target,
      data: liqEth.interface.encodeFunctionData(LiqEthFunction.transfer, [
        pool,
        amount
      ])
    }
  }

  /**
   * `SyndicationPool.syndicate(amount, compressedPubkey)`.
   *
   * @param pool - The bound pool.
   * @param amount - Wei to syndicate.
   * @param compressedPubkey - The sender's compressed key, `0x` hex.
   * @returns The transaction request.
   */
  export function syndicateRequest(
    pool: ethers.BaseContract,
    amount: bigint,
    compressedPubkey: string
  ): ethers.TransactionRequest {
    return {
      to: pool.target,
      data: pool.interface.encodeFunctionData(PoolFunction.syndicate, [
        amount,
        compressedPubkey
      ])
    }
  }

  /**
   * `SyndicationPool.pause()` or `unpause()`.
   *
   * @param pool - The bound pool.
   * @param paused - `true` for `pause()`, `false` for `unpause()`.
   * @returns The transaction request.
   */
  export function setPausedRequest(
    pool: ethers.BaseContract,
    paused: boolean
  ): ethers.TransactionRequest {
    return {
      to: pool.target,
      data: pool.interface.encodeFunctionData(
        paused ? PoolFunction.pause : PoolFunction.unpause,
        []
      )
    }
  }

  /**
   * `SyndicationPool.payPendingDesyndication(requestId)`.
   *
   * @param pool - The bound pool.
   * @param requestId - The depot request id the release was stored under.
   * @returns The transaction request.
   */
  export function payPendingDesyndicationRequest(
    pool: ethers.BaseContract,
    requestId: bigint
  ): ethers.TransactionRequest {
    return {
      to: pool.target,
      data: pool.interface.encodeFunctionData(
        PoolFunction.payPendingDesyndication,
        [requestId]
      )
    }
  }

  /**
   * Send `request` from `signer` with an explicitly drawn nonce and wait for
   * it to mine — the ONE submission path for this tool's runners.
   *
   * @param signer - The signing wallet (connected).
   * @param request - The call to send.
   * @param label - What is being sent, for the failure message.
   * @throws If the transaction reverts.
   */
  async function send(
    signer: ethers.Signer,
    request: ethers.TransactionRequest,
    label: string
  ): Promise<void> {
    const nonce = await resolveLatestNonce(signer),
      response = await signer.sendTransaction({ ...request, nonce }),
      receipt = await response.wait(Confirmations)
    Assert.ok(
      receipt?.status === 1,
      `${label}: reverted (status=${receipt?.status ?? "null"})`
    )
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * The pool's custody in the depot frame (`poolBalanceDepot()`), the figure
   * the solvency check compares with the depot's outstanding shadow. A READ.
   *
   * @param ctx - The build context.
   * @returns Depot units (9 decimals).
   */
  export async function readPoolBalanceDepot<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<bigint> {
    return loadSyndicationPool(ctx, ctx.ethereum.provider).poolBalanceDepot()
  }

  /**
   * The release the pool stored under `requestId`, or `undefined` when none is
   * stored (never deferred, or already paid — paying deletes it). A READ.
   *
   * @param ctx - The build context.
   * @param requestId - The depot request id.
   * @returns The stored release, or `undefined`.
   */
  export async function readPendingDesyndication<
    C extends ClusterBuildContext
  >(ctx: C, requestId: bigint): Promise<PendingDesyndication> {
    const [recipient, depotAmount, reason] = await loadSyndicationPool(
      ctx,
      ctx.ethereum.provider
    ).pendingDesyndications(requestId)
    // `depotAmount != 0` is the contract's own "a record is stored" marker.
    if (depotAmount === 0n) return undefined
    return { recipient, depotAmount, reason: Number(reason) }
  }

  /**
   * Whether the pool is paused (the emergency stop, or its own custody
   * shortfall pause). A READ.
   *
   * @param ctx - The build context.
   * @returns The pause flag.
   */
  export async function readPaused<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<boolean> {
    return loadSyndicationPool(ctx, ctx.ethereum.provider).paused()
  }

  /**
   * `account`'s liqETH balance, in wei. A READ.
   *
   * @param ctx - The build context.
   * @param account - The address to read.
   * @returns The balance.
   */
  export async function readLiqEthBalance<C extends ClusterBuildContext>(
    ctx: C,
    account: string
  ): Promise<bigint> {
    return loadLiqEthToken(ctx, ctx.ethereum.provider).balanceOf(account)
  }

  /**
   * The pool configuration the deploy sets. A READ.
   *
   * @param ctx - The build context.
   * @returns The four configured values.
   */
  export async function readPoolConfiguration<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<PoolConfiguration> {
    const pool = loadSyndicationPool(ctx, ctx.ethereum.provider)
    return {
      maxSyndicationPerTransfer: await pool.maxSyndicationPerTransfer(),
      yieldDeadband: await pool.yieldDeadband(),
      liqTokenCode: await pool.liqTokenCode(),
      liqTokenPrecision: Number(await pool.liqTokenPrecision())
    }
  }

  /**
   * Whether `account` may call `functionName` on the pool right now, as the
   * pool's access manager answers it (`canCall`, immediate). A READ — the
   * configuration check asks it for the panic account and `pause` /
   * `unpause`.
   *
   * @param ctx - The build context.
   * @param account - The caller to ask about.
   * @param functionName - The pool function.
   * @returns Whether the call is immediately permitted.
   */
  export async function readCanCallPool<C extends ClusterBuildContext>(
    ctx: C,
    account: string,
    functionName: PoolFunction
  ): Promise<boolean> {
    const pool = loadSyndicationPool(ctx, ctx.ethereum.provider),
      manager = loadOutpostManagerAuthority(ctx, ctx.ethereum.provider),
      authority = await pool.authority()
    // The pool must answer to THIS manager, or its answer is about another pool.
    Assert.ok(
      ethers.getAddress(authority) === ethers.getAddress(await manager.getAddress()),
      `EthereumSyndicationTool: SyndicationPool's authority is ${authority}, not the deployed ` +
        `${OutpostManagerAuthorityContractName} ${await manager.getAddress()}`
    )
    const [immediate] = await manager.canCall(
        account,
        await pool.getAddress(),
        pool.interface.getFunction(functionName).selector
      )
    return immediate
  }

  /**
   * The depot token code the pool must report under — `LIQETH` as a packed
   * slug. A pure value helper.
   *
   * @returns The token code.
   */
  export function liqEthTokenCode(): bigint {
    return BigInt(SlugName.from(LiqEthTokenCodename))
  }

  // ── Step: ETH → liqETH (`DepositManager.deposit`) ────────────────────────

  /** Input for {@link planDepositLiqEth} — one `deposit` write. */
  export interface DepositLiqEthInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.DepositLiqEthInput"
    /** Anvil HD index of the depositing holder. */
    readonly ethereumHdIndex: number
    /** Wei deposited (`msg.value`). */
    readonly amountWei: bigint
  }

  /**
   * A single `DepositManager.deposit{value: amountWei}()` — the holder is
   * minted liqETH for the deposit.
   *
   * @param actor - The narrative subject (the holder).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param ethereumHdIndex - Anvil HD index of the holder.
   * @param amountWei - Wei to deposit.
   * @returns The definition step.
   */
  export function planDepositLiqEth<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    amountWei: bigint
  ): ClusterBuildStep<C, DepositLiqEthInput> {
    return ClusterBuildStep.create<C, DepositLiqEthInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.DepositLiqEthInput",
        ethereumHdIndex,
        amountWei
      },
      runDepositLiqEth
    )
  }

  /** Named runner — ONE `DepositManager.deposit`, signed by the holder. */
  export async function runDepositLiqEth<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositLiqEthInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.amountWei > 0n,
      "EthereumSyndicationTool.planDepositLiqEth: amountWei must be positive"
    )
    const holder = hdWallet(ctx, input.ethereumHdIndex)
    await send(
      holder,
      depositLiqEthRequest(loadDepositManager(ctx, holder), input.amountWei),
      "EthereumSyndicationTool.planDepositLiqEth"
    )
  }

  /** Manager entry points used for restricted pool configuration. */
  export enum ManagerFunction {
    execute = "execute"
  }

  /** Read the principal already reconciled against depot shadow, in depot units. */
  export async function readSyndicatedPrincipal<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<bigint> {
    return loadSyndicationPool(ctx, ctx.ethereum.provider).syndicatedPrincipal()
  }

  /** Input to the bootstrap-only principal seed, after custody funding. */
  export interface InitializeSyndicationInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.InitializeSyndicationInput"
    readonly ethereumHdIndex: number
    readonly initialPrincipal: bigint
  }

  /** Plan one manager transaction seeding principal without changing pool configuration. */
  export function planInitializeSyndication<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    initialPrincipal: bigint
  ): ClusterBuildStep<C, InitializeSyndicationInput> {
    return ClusterBuildStep.create<C, InitializeSyndicationInput>(
      actor, name, description, options,
      { kind: "EthereumSyndicationTool.InitializeSyndicationInput", ethereumHdIndex, initialPrincipal },
      runInitializeSyndication
    )
  }

  /** ONE restricted reinitializer, routed through the manager by its configuration signer. */
  export async function runInitializeSyndication<C extends ClusterBuildContext>(
    ctx: C,
    input: InitializeSyndicationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.initialPrincipal >= 0n, "initial principal must not be negative")
    const signer = hdWallet(ctx, input.ethereumHdIndex),
      pool = loadSyndicationPool(ctx, signer),
      manager = loadOutpostContract<object>(
        ctx.config.ethereumPath,
        readDeployAddresses(ctx, EthereumOutpostBootstrapper.OutpostAddressesFile),
        EthereumOutpostBootstrapper.OutpostManagerContractName,
        [...EthereumOutpostBootstrapper.OutpostArtifactSubpath],
        signer,
        EthereumOutpostBootstrapper.OutpostManagerContractName,
        EthereumOutpostBootstrapper.OutpostManagerArtifactName
      ),
      configuration = await Promise.all([
        pool.outpostChainCode(), pool.liqTokenCode(),
        pool.liqTokenPrecision(), pool.yieldDeadband()
      ])
    await send(signer, {
      to: manager.target,
      data: manager.interface.encodeFunctionData(ManagerFunction.execute, [
        await pool.getAddress(),
        pool.interface.encodeFunctionData(PoolFunction.initializeSyndication, [
          ...configuration, input.initialPrincipal
        ])
      ])
    }, "EthereumSyndicationTool.planInitializeSyndication")
  }

  // ── Step: liqETH allowance for the pool (`approve`) ──────────────────────

  /** Input for {@link planApproveLiqEth} — one `approve` write. */
  export interface ApproveLiqEthInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.ApproveLiqEthInput"
    /** Anvil HD index of the approving holder. */
    readonly ethereumHdIndex: number
    /** The allowance granted to the pool, in wei. */
    readonly amount: bigint
  }

  /**
   * A single `liqETH.approve(SyndicationPool, amount)` — the allowance
   * `syndicate` draws with `transferFrom`.
   *
   * @param actor - The narrative subject (the holder).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param ethereumHdIndex - Anvil HD index of the holder.
   * @param amount - The allowance, in wei.
   * @returns The definition step.
   */
  export function planApproveLiqEth<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    amount: bigint
  ): ClusterBuildStep<C, ApproveLiqEthInput> {
    return ClusterBuildStep.create<C, ApproveLiqEthInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.ApproveLiqEthInput",
        ethereumHdIndex,
        amount
      },
      runApproveLiqEth
    )
  }

  /** Named runner — ONE `liqETH.approve(pool, amount)`, signed by the holder. */
  export async function runApproveLiqEth<C extends ClusterBuildContext>(
    ctx: C,
    input: ApproveLiqEthInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const holder = hdWallet(ctx, input.ethereumHdIndex),
      pool = loadSyndicationPool(ctx, holder)
    await send(
      holder,
      approveLiqEthRequest(
        loadLiqEthToken(ctx, holder),
        await pool.getAddress(),
        input.amount
      ),
      "EthereumSyndicationTool.planApproveLiqEth"
    )
  }

  // ── Step: syndicate liqETH (`SyndicationPool.syndicate`) ─────────────────

  /** Input for {@link planSyndicate} — one `syndicate` write. */
  export interface SyndicateInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.SyndicateInput"
    /** Anvil HD index of the syndicating holder (the sender). */
    readonly ethereumHdIndex: number
    /** Wei to syndicate. */
    readonly amount: bigint
    /** The 33-byte compressed key the depot parks the syndication against, `0x` hex. */
    readonly compressedPubkey: string
  }

  /**
   * A single `SyndicationPool.syndicate(amount, compressedPubkey)`. The pool
   * takes the liqETH (it needs the allowance of {@link planApproveLiqEth}) and
   * queues `SYNDICATE_LIQ`; it refuses an amount above its per-transfer
   * maximum, a key that does not derive to the sender, and any call while
   * paused. The key is carried as given, so a flow can present a wrong one.
   *
   * @param actor - The narrative subject (the holder).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param ethereumHdIndex - Anvil HD index of the holder.
   * @param amount - Wei to syndicate.
   * @param compressedPubkey - The compressed key (see {@link compressedPubkey}).
   * @returns The definition step.
   */
  export function planSyndicate<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    amount: bigint,
    compressedPubkey: string
  ): ClusterBuildStep<C, SyndicateInput> {
    return ClusterBuildStep.create<C, SyndicateInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.SyndicateInput",
        ethereumHdIndex,
        amount,
        compressedPubkey
      },
      runSyndicate
    )
  }

  /** Named runner — ONE `SyndicationPool.syndicate`, signed by the holder. */
  export async function runSyndicate<C extends ClusterBuildContext>(
    ctx: C,
    input: SyndicateInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.amount > 0n,
      "EthereumSyndicationTool.planSyndicate: amount must be positive"
    )
    const holder = hdWallet(ctx, input.ethereumHdIndex)
    await send(
      holder,
      syndicateRequest(
        loadSyndicationPool(ctx, holder),
        input.amount,
        input.compressedPubkey
      ),
      "EthereumSyndicationTool.planSyndicate"
    )
  }

  // ── Step: donate liqETH to the pool (an ERC-20 transfer) ─────────────────

  /** Input for {@link planDonateToPool} — one liqETH transfer into the pool. */
  export interface DonateToPoolInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.DonateToPoolInput"
    /** Anvil HD index of the donor. */
    readonly ethereumHdIndex: number
    /** Wei to transfer. */
    readonly amount: bigint
  }

  /**
   * A single `liqETH.transfer(SyndicationPool, amount)` — custody the depot
   * never credited, which leaves the pool holding MORE than the depot's
   * outstanding shadow (and, above the deadband, reportable yield).
   *
   * @param actor - The narrative subject (the donor).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param ethereumHdIndex - Anvil HD index of the donor.
   * @param amount - Wei to transfer.
   * @returns The definition step.
   */
  export function planDonateToPool<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    amount: bigint
  ): ClusterBuildStep<C, DonateToPoolInput> {
    return ClusterBuildStep.create<C, DonateToPoolInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.DonateToPoolInput",
        ethereumHdIndex,
        amount
      },
      runDonateToPool
    )
  }

  /** Named runner — ONE `liqETH.transfer(pool, amount)`, signed by the donor. */
  export async function runDonateToPool<C extends ClusterBuildContext>(
    ctx: C,
    input: DonateToPoolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.amount > 0n,
      "EthereumSyndicationTool.planDonateToPool: amount must be positive"
    )
    const donor = hdWallet(ctx, input.ethereumHdIndex),
      pool = loadSyndicationPool(ctx, donor)
    await send(
      donor,
      donateToPoolRequest(
        loadLiqEthToken(ctx, donor),
        await pool.getAddress(),
        input.amount
      ),
      "EthereumSyndicationTool.planDonateToPool"
    )
  }

  // ── Step: the emergency stop (`SyndicationPool.pause` / `unpause`) ───────

  /** Input for {@link planSetPaused} — one panic-signed `pause` / `unpause` write. */
  export interface SetPausedInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.SetPausedInput"
    /** Anvil HD index of the signer — the panic account the deploy config named. */
    readonly ethereumHdIndex: number
    /** `true` sends `pause()`, `false` sends `unpause()`. */
    readonly paused: boolean
  }

  /**
   * A single `SyndicationPool.pause()` or `unpause()`, signed by the panic
   * account ({@link EthereumOutpostBootstrapper.PanicAccountIndex}, carried on
   * the input so the Report names the signer). While paused, `syndicate` and
   * `realizeYield` revert with `EnforcedPause` and every inbound
   * `DESYNDICATE_LIQ` is stored rather than paid; `unpause` lifts the
   * emergency stop and the pool's own custody-shortfall pause alike.
   *
   * @param actor - The narrative subject (the panic account).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param paused - Whether to pause or unpause.
   * @returns The definition step.
   */
  export function planSetPaused<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    paused: boolean
  ): ClusterBuildStep<C, SetPausedInput> {
    return ClusterBuildStep.create<C, SetPausedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.SetPausedInput",
        ethereumHdIndex: EthereumOutpostBootstrapper.PanicAccountIndex,
        paused
      },
      runSetPaused
    )
  }

  /** Named runner — ONE `pause()` / `unpause()`, signed by the input's panic account. */
  export async function runSetPaused<C extends ClusterBuildContext>(
    ctx: C,
    input: SetPausedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const panic = hdWallet(ctx, input.ethereumHdIndex)
    await send(
      panic,
      setPausedRequest(loadSyndicationPool(ctx, panic), input.paused),
      `EthereumSyndicationTool.planSetPaused ${input.paused}`
    )
  }

  // ── Step: pay a stored release (`SyndicationPool.payPendingDesyndication`) ──

  /** Input for {@link planPayPendingDesyndication} — one permissionless crank write. */
  export interface PayPendingDesyndicationInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.PayPendingDesyndicationInput"
    /** Anvil HD index of the caller (any account may crank). */
    readonly ethereumHdIndex: number
    /** The depot request id the release was stored under. */
    readonly requestId: bigint
  }

  /**
   * A single permissionless `SyndicationPool.payPendingDesyndication(requestId)`:
   * pays the stored release and deletes it, so it is paid exactly once. It
   * reverts while the pool is paused, and for an id with nothing stored.
   *
   * @param actor - The narrative subject (the cranker).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param ethereumHdIndex - Anvil HD index of the caller.
   * @param requestId - The stored release's depot request id.
   * @returns The definition step.
   */
  export function planPayPendingDesyndication<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    requestId: bigint
  ): ClusterBuildStep<C, PayPendingDesyndicationInput> {
    return ClusterBuildStep.create<C, PayPendingDesyndicationInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.PayPendingDesyndicationInput",
        ethereumHdIndex,
        requestId
      },
      runPayPendingDesyndication
    )
  }

  /** Named runner — ONE `payPendingDesyndication`, signed by the caller. */
  export async function runPayPendingDesyndication<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: PayPendingDesyndicationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const caller = hdWallet(ctx, input.ethereumHdIndex)
    await send(
      caller,
      payPendingDesyndicationRequest(
        loadSyndicationPool(ctx, caller),
        input.requestId
      ),
      `EthereumSyndicationTool.planPayPendingDesyndication ${input.requestId}`
    )
  }
}
