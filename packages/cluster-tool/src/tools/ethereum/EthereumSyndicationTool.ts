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
 * A holder is a persisted per-cluster wallet, named by its durable handle
 * (`EthereumWallet`; created and funded through `EthereumFundingTool`). ABIs
 * come from the run's `<ethereumPath>/artifacts/contracts/…` and addresses
 * from this cluster's deploy-artifact files, both resolved inside the runners;
 * each runner encodes its ONE call through the request builders below, which
 * are pure and therefore what the unit tests check.
 *
 * Every loader and read is addressed by an {@link EthereumOutpostSource}: a
 * Step runner's `ctx` (its provider, `ethereumPath` and deploy records, each
 * resolved at the point of use) or an {@link EthereumOutpostTarget} composed
 * without a cluster (`fund-batch-operators`, over an `ExternalOutpostConfig`).
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import { ethers } from "ethers"
import { SlugName } from "@wireio/sdk-core"

import { EthereumWallet } from "../../clients/ethereum/EthereumWallet.js"
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
import { EthereumFundingTool } from "./EthereumFundingTool.js"
import {
  EthereumOutpostTarget,
  type EthereumOutpostSource
} from "./EthereumOutpostTarget.js"

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
    custodyShortfallBps(): Promise<bigint>
    syndicatedPrincipal(): Promise<bigint>
    outpostChainCode(): Promise<bigint>
    pendingDesyndications(requestId: bigint): Promise<[string, bigint, bigint]>
    maxSyndicationPerTransfer(): Promise<bigint>
    yieldDeadband(): Promise<bigint>
    liqTokenCode(): Promise<bigint>
    liqTokenPrecision(): Promise<bigint>
    authority(): Promise<string>
  }

  /**
   * `SyndicationPool` events this tool reads, by ABI name.
   */
  export enum PoolEvent {
    Syndicated = "Syndicated",
    Desyndicated = "Desyndicated",
    CustodyShortfall = "CustodyShortfall",
    CustodyShortfallTolerated = "CustodyShortfallTolerated"
  }

  /** The ratio check's actual custody and post-burn outstanding, from its event. */
  export interface CustodyCheck {
    requestId: bigint
    postPayoutBalanceDepot: bigint
    totalSyndicated: bigint
    /** Event allowance for a tolerated payout; live allowance for a refused payout. */
    toleranceBps: bigint
  }

  /** ERC-20 events used to verify a pool payment's receipt. */
  export enum LiqEthEvent {
    Transfer = "Transfer"
  }

  /** The first block an event scan covers — the whole cluster chain. */
  export const EventScanFromBlock = 0

  /**
   * The liqETH token reads this tool makes. Each takes optional ethers
   * overrides so a read can be pinned to a `blockTag`.
   */
  export interface LiqEthTokenView {
    balanceOf(account: string, overrides?: ethers.Overrides): Promise<bigint>
    /** The ERC-20 allowance `owner` has granted `spender`. */
    allowance(
      owner: string,
      spender: string,
      overrides?: ethers.Overrides
    ): Promise<bigint>
    /** The rebasing index (`RewardsERC20.index`). */
    index(overrides?: ethers.Overrides): Promise<bigint>
    /** The index's fixed-point unit (`RewardsERC20.unit`). */
    unit(overrides?: ethers.Overrides): Promise<bigint>
  }

  /**
   * One `SyndicationPool.Desyndicated` event — a depot release the pool PAID,
   * verified against the liqETH transfer in its successful receipt.
   */
  export interface DesyndicationPayment {
    /** The payout address. */
    recipient: string
    /** liqETH wei the pool transferred. */
    nativeAmount: bigint
    /** The depot units (9 decimals) the release carried. */
    depotAmount: bigint
    /** The depot request id. */
    requestId: bigint
    /** The block the payment landed in. */
    blockNumber: number
    /** The payment transaction's index inside that block. */
    transactionIndex: number
  }

  /**
   * liqETH's share rate at one block: `balance = floor(shares · index / unit)`
   * and a transfer of `value` moves `ceil(value · unit / index)` shares
   * (`RewardsERC20._shareToToken` / `previewShares`).
   */
  export interface LiqEthRate {
    /** `RewardsERC20.index()`. */
    index: bigint
    /** `RewardsERC20.unit()`. */
    unit: bigint
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
   * The `wire-ethereum` artifact tree a source addresses — the target's own,
   * or the context's configured `ethereumPath`.
   *
   * @param source - The build context, or a target.
   * @returns The repo root.
   */
  function ethereumPathOf<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): string {
    return EthereumOutpostTarget.is(source)
      ? source.ethereumPath
      : source.config.ethereumPath
  }

  /**
   * The outpost address book a source addresses — the target's own, or this
   * cluster's `outpost-addrs.json` read at the point of use (a context's
   * records are files the deploy wrote; nothing reads them before a runner
   * needs them).
   *
   * @param source - The build context, or a target.
   * @returns The contract-name → address map.
   */
  function outpostAddressesOf<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): Record<string, string> {
    return EthereumOutpostTarget.is(source)
      ? source.outpostAddresses
      : readDeployAddresses(
          source,
          EthereumOutpostBootstrapper.OutpostAddressesFile
        )
  }

  /**
   * The liqEth address book a source addresses — the target's own (asserted
   * present: an outpost without liqETH has no deposit manager or token to
   * load), or this cluster's `liqeth-addrs.json` read at the point of use.
   *
   * @param source - The build context, or a target.
   * @returns The contract-name → address map.
   * @throws If a target carries no liqEth addresses.
   */
  function liqEthAddressesOf<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): Record<string, string> {
    if (!EthereumOutpostTarget.is(source)) {
      return readDeployAddresses(
        source,
        EthereumOutpostBootstrapper.LiqEthAddressesFile
      )
    }
    Assert.ok(
      source.liqEthAddresses != null,
      "EthereumSyndicationTool: the outpost target carries no liqEthAddresses — the outpost has no liqETH deploy to load"
    )
    return source.liqEthAddresses
  }

  /**
   * The provider a source reads through — the target's own, or the context's
   * recording provider (resolved at the point of use: a context's client is
   * lazy, and throws for an external-outpost cluster).
   *
   * @param source - The build context, or a target.
   * @returns The provider.
   */
  function providerOf<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): ethers.Provider {
    return EthereumOutpostTarget.is(source)
      ? source.provider
      : source.ethereum.provider
  }

  /**
   * The deployed `SyndicationPool`, from the source's outpost address book and
   * the hardhat artifact.
   *
   * @param source - The build context, or a target.
   * @param runner - The signer (writes) or provider (reads) to bind.
   * @returns The pool contract.
   */
  export function loadSyndicationPool<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    runner: ethers.ContractRunner
  ): SyndicationPoolView & ethers.BaseContract {
    return loadOutpostContract<SyndicationPoolView>(
      ethereumPathOf(source),
      outpostAddressesOf(source),
      SyndicationPoolContractName,
      [...SyndicationPoolArtifactSubpath],
      runner
    )
  }

  /**
   * The deployed `DepositManager`, from the source's liqEth address book and
   * the hardhat artifact.
   *
   * @param source - The build context, or a target.
   * @param runner - The signer to bind.
   * @returns The deposit-manager contract.
   */
  export function loadDepositManager<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    runner: ethers.ContractRunner
  ): ethers.BaseContract {
    return loadOutpostContract<object>(
      ethereumPathOf(source),
      liqEthAddressesOf(source),
      DepositManagerContractName,
      [...DepositManagerArtifactSubpath],
      runner
    )
  }

  /**
   * The deployed liqETH token, from the source's liqEth address book and the
   * hardhat artifact.
   *
   * @param source - The build context, or a target.
   * @param runner - The signer (writes) or provider (reads) to bind.
   * @returns The token contract.
   */
  export function loadLiqEthToken<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    runner: ethers.ContractRunner
  ): LiqEthTokenView & ethers.BaseContract {
    return loadOutpostContract<LiqEthTokenView>(
      ethereumPathOf(source),
      liqEthAddressesOf(source),
      LiqEthTokenContractName,
      [...LiqEthTokenArtifactSubpath],
      runner,
      LiqEthTokenSourceName
    )
  }

  /**
   * The deployed outpost access manager, from the source's outpost address
   * book and the hardhat artifact.
   *
   * @param source - The build context, or a target.
   * @param runner - The provider to bind.
   * @returns The access-manager contract.
   */
  export function loadOutpostManagerAuthority<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    runner: ethers.ContractRunner
  ): AccessManagerView & ethers.BaseContract {
    return loadOutpostContract<AccessManagerView>(
      ethereumPathOf(source),
      outpostAddressesOf(source),
      OutpostManagerAuthorityContractName,
      [...OutpostManagerAuthorityArtifactSubpath],
      runner
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
  export function readPoolBalanceDepot(
    target: EthereumOutpostTarget
  ): Promise<bigint>
  export function readPoolBalanceDepot<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<bigint>
  export async function readPoolBalanceDepot<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): Promise<bigint> {
    return loadSyndicationPool(source, providerOf(source)).poolBalanceDepot()
  }

  /**
   * Read the pool's governed, inclusive custody-gap allowance without changing it.
   * @param source - The build context, or a target.
   * @returns The deployed allowance in basis points.
   */
  export function readCustodyShortfallBps(
    target: EthereumOutpostTarget
  ): Promise<bigint>
  export function readCustodyShortfallBps<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<bigint>
  export async function readCustodyShortfallBps<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): Promise<bigint> {
    return loadSyndicationPool(source, providerOf(source)).custodyShortfallBps()
  }

  /**
   * Read the successful transaction's custody-check event for one request.
   * Missing evidence returns undefined for polling; duplicate evidence is refused.
   * A refused check must still fully fund the payout, isolating the ratio guard.
   * @param source - The build context, or a target.
   * @param requestId - The depot request id.
   * @param depotAmount - The exact net redemption, in depot units.
   * @param tolerated - Select the tolerated event rather than the refusal event.
   * @returns Actual projected custody, post-burn outstanding and allowance, or undefined.
   */
  export function readCustodyCheck(
    target: EthereumOutpostTarget,
    requestId: bigint,
    depotAmount: bigint,
    tolerated: boolean
  ): Promise<CustodyCheck>
  export function readCustodyCheck<C extends ClusterBuildContext>(
    ctx: C,
    requestId: bigint,
    depotAmount: bigint,
    tolerated: boolean
  ): Promise<CustodyCheck>
  export async function readCustodyCheck<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    requestId: bigint,
    depotAmount: bigint,
    tolerated: boolean
  ): Promise<CustodyCheck> {
    const pool = loadSyndicationPool(source, providerOf(source)),
      eventName = tolerated
        ? PoolEvent.CustodyShortfallTolerated
        : PoolEvent.CustodyShortfall,
      events = await pool.queryFilter(
        pool.getEvent(eventName),
        EventScanFromBlock
      ),
      checks = events
        .map(event => {
          Assert.ok(
            event instanceof ethers.EventLog,
            `Undecoded ${eventName} event`
          )
          return event
        })
        .filter(event => BigInt(event.args.requestId) === requestId)
    if (!checks.length) return undefined
    Assert.strictEqual(
      checks.length,
      1,
      `Expected exactly one ${eventName} for request ${requestId}`
    )
    const [check] = checks,
      receipt = await check.getTransactionReceipt()
    Assert.strictEqual(
      receipt?.status,
      1,
      `Custody check ${requestId} has no successful receipt`
    )
    Assert.strictEqual(receipt.blockHash, check.blockHash)
    const balance = BigInt(
      tolerated
        ? check.args.postPayoutBalanceDepot
        : check.args.poolBalanceDepot
    )
    if (!tolerated)
      Assert.ok(balance >= depotAmount, "custody must fully fund the payout")
    return {
      requestId,
      postPayoutBalanceDepot: tolerated ? balance : balance - depotAmount,
      totalSyndicated: BigInt(check.args.totalSyndicated),
      toleranceBps: tolerated
        ? BigInt(check.args.toleranceBps)
        : await pool.custodyShortfallBps()
    }
  }

  /**
   * The release the pool stored under `requestId`, or `undefined` when none is
   * stored (never deferred, or already paid — paying deletes it). A READ.
   *
   * @param source - The build context, or a target.
   * @param requestId - The depot request id.
   * @returns The stored release, or `undefined`.
   */
  export function readPendingDesyndication(
    target: EthereumOutpostTarget,
    requestId: bigint
  ): Promise<PendingDesyndication>
  export function readPendingDesyndication<C extends ClusterBuildContext>(
    ctx: C,
    requestId: bigint
  ): Promise<PendingDesyndication>
  export async function readPendingDesyndication<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    requestId: bigint
  ): Promise<PendingDesyndication> {
    const [recipient, depotAmount, reason] = await loadSyndicationPool(
      source,
      providerOf(source)
    ).pendingDesyndications(requestId)
    // `depotAmount != 0` is the contract's own "a record is stored" marker.
    if (depotAmount === 0n) return undefined
    return { recipient, depotAmount, reason: Number(reason) }
  }

  /**
   * Whether the pool is paused (the emergency stop, or its own custody
   * shortfall pause). A READ.
   *
   * @param source - The build context, or a target.
   * @returns The pause flag.
   */
  export function readPaused(
    target: EthereumOutpostTarget
  ): Promise<boolean>
  export function readPaused<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<boolean>
  export async function readPaused<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): Promise<boolean> {
    return loadSyndicationPool(source, providerOf(source)).paused()
  }

  /**
   * `account`'s liqETH balance, in wei. A READ.
   *
   * @param source - The build context, or a target.
   * @param account - The address to read.
   * @param blockTag - The block to read at; the latest when omitted.
   * @returns The balance.
   */
  export function readLiqEthBalance(
    target: EthereumOutpostTarget,
    account: string,
    blockTag?: ethers.BlockTag
  ): Promise<bigint>
  export function readLiqEthBalance<C extends ClusterBuildContext>(
    ctx: C,
    account: string,
    blockTag?: ethers.BlockTag
  ): Promise<bigint>
  export async function readLiqEthBalance<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    account: string,
    blockTag?: ethers.BlockTag
  ): Promise<bigint> {
    return loadLiqEthToken(source, providerOf(source)).balanceOf(account, {
      blockTag
    })
  }

  /**
   * The liqETH allowance `owner` has granted `spender` — what the pool's
   * `syndicate` draws with `transferFrom`. A READ.
   *
   * @param source - The build context, or a target.
   * @param owner - The token holder.
   * @param spender - The address allowed to draw (the pool).
   * @returns The allowance, in wei.
   */
  export function readLiqEthAllowance(
    target: EthereumOutpostTarget,
    owner: string,
    spender: string
  ): Promise<bigint>
  export function readLiqEthAllowance<C extends ClusterBuildContext>(
    ctx: C,
    owner: string,
    spender: string
  ): Promise<bigint>
  export async function readLiqEthAllowance<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    owner: string,
    spender: string
  ): Promise<bigint> {
    return loadLiqEthToken(source, providerOf(source)).allowance(owner, spender)
  }

  /**
   * liqETH's share rate at `blockTag`. A READ.
   *
   * @param source - The build context, or a target.
   * @param blockTag - The block to read at.
   * @returns The index and its unit.
   */
  export function readLiqEthRate(
    target: EthereumOutpostTarget,
    blockTag: ethers.BlockTag
  ): Promise<LiqEthRate>
  export function readLiqEthRate<C extends ClusterBuildContext>(
    ctx: C,
    blockTag: ethers.BlockTag
  ): Promise<LiqEthRate>
  export async function readLiqEthRate<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    blockTag: ethers.BlockTag
  ): Promise<LiqEthRate> {
    const token = loadLiqEthToken(source, providerOf(source))
    return {
      index: await token.index({ blockTag }),
      unit: await token.unit({ blockTag })
    }
  }

  /**
   * The ONE `Desyndicated` event for `requestId`, backed by exactly one matching
   * liqETH transfer in its successful receipt. A READ, independent of block position.
   *
   * @param source - The build context, or a target.
   * @param requestId - The depot request id.
   * @returns The payment and its block position.
   * @throws If the payment or its matching token transfer is missing or duplicated.
   */
  export function readDesyndicationPayment(
    target: EthereumOutpostTarget,
    requestId: bigint
  ): Promise<DesyndicationPayment>
  export function readDesyndicationPayment<C extends ClusterBuildContext>(
    ctx: C,
    requestId: bigint
  ): Promise<DesyndicationPayment>
  export async function readDesyndicationPayment<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    requestId: bigint
  ): Promise<DesyndicationPayment> {
    const pool = loadSyndicationPool(source, providerOf(source)),
      events = await pool.queryFilter(
        pool.getEvent(PoolEvent.Desyndicated),
        EventScanFromBlock
      ),
      payments = events
        .map(event => {
          Assert.ok(
            event instanceof ethers.EventLog,
            `EthereumSyndicationTool: an undecoded ${PoolEvent.Desyndicated} log in tx ${event.transactionHash}`
          )
          return event
        })
        .filter(event => BigInt(event.args.requestId) === requestId)
    Assert.strictEqual(
      payments.length,
      1,
      `EthereumSyndicationTool: expected exactly one ${PoolEvent.Desyndicated} event for request ` +
        `${requestId}, found ${payments.length}`
    )
    const [payment] = payments
    await assertDesyndicationTransfer(source, pool, payment)
    return {
      recipient: payment.args.recipient,
      nativeAmount: BigInt(payment.args.nativeAmount),
      depotAmount: BigInt(payment.args.depotAmount),
      requestId: BigInt(payment.args.requestId),
      blockNumber: payment.blockNumber,
      transactionIndex: payment.transactionIndex
    }
  }

  /** Verify the pool's payment against the actual token transfer in its receipt. */
  async function assertDesyndicationTransfer<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    pool: ReturnType<typeof loadSyndicationPool>,
    payment: ethers.EventLog
  ): Promise<void> {
    const receipt = await payment.getTransactionReceipt()
    Assert.ok(
      receipt?.status,
      `EthereumSyndicationTool: payment ${payment.transactionHash} has no successful receipt`
    )
    Assert.strictEqual(receipt.blockHash, payment.blockHash)
    const token = loadLiqEthToken(source, providerOf(source)),
      tokenAddress = ethers.getAddress(await token.getAddress()),
      poolAddress = ethers.getAddress(await pool.getAddress()),
      transferTopic = token.interface.getEvent(LiqEthEvent.Transfer).topicHash,
      transfers = receipt.logs
        .filter(
          event =>
            ethers.getAddress(event.address) === tokenAddress &&
            event.topics[0] === transferTopic
        )
        .map(event => token.interface.parseLog(event))
        .filter(
          event =>
            ethers.getAddress(event.args.from) === poolAddress &&
            ethers.getAddress(event.args.to) ===
              ethers.getAddress(payment.args.recipient) &&
            BigInt(event.args.value) === BigInt(payment.args.nativeAmount)
        )
    Assert.strictEqual(
      transfers.length,
      1,
      `EthereumSyndicationTool: expected exactly one matching liqETH transfer for request ` +
        `${payment.args.requestId}, found ${transfers.length}`
    )
  }

  /**
   * The balance a liqETH holder ends with after receiving `value` wei, by the
   * token's own share arithmetic: the holder's shares are recovered from its
   * balance, `ceil(value · unit / index)` shares are added, and the result is
   * `floor(shares · index / unit)`. A pure value helper — the exact figure a
   * rebasing token makes of a transfer, which can exceed `balance + value`.
   *
   * @param balance - The holder's balance before the transfer.
   * @param value - The wei transferred.
   * @param rate - The share rate the transfer ran at.
   * @returns The balance after the transfer.
   * @throws If `index < unit` (a share is then worth under one wei, so a
   *   balance no longer determines its share count).
   */
  export function liqEthBalanceAfterTransfer(
    balance: bigint,
    value: bigint,
    rate: LiqEthRate
  ): bigint {
    const { index, unit } = rate
    Assert.ok(
      index >= unit,
      `EthereumSyndicationTool: liqETH index ${index} below its unit ${unit} — shares are not recoverable from a balance`
    )
    const shares = ceilDiv(balance * unit, index)
    Assert.strictEqual(
      (shares * index) / unit,
      balance,
      `EthereumSyndicationTool: no share count yields balance ${balance} at index ${index}/${unit}`
    )
    return ((shares + ceilDiv(value * unit, index)) * index) / unit
  }

  /** `ceil(numerator / denominator)` for non-negative bigints. */
  function ceilDiv(numerator: bigint, denominator: bigint): bigint {
    return (numerator + denominator - 1n) / denominator
  }

  /**
   * The pool configuration the deploy sets. A READ.
   *
   * @param ctx - The build context.
   * @returns The four configured values.
   */
  export function readPoolConfiguration(
    target: EthereumOutpostTarget
  ): Promise<PoolConfiguration>
  export function readPoolConfiguration<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<PoolConfiguration>
  export async function readPoolConfiguration<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): Promise<PoolConfiguration> {
    const pool = loadSyndicationPool(source, providerOf(source))
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
   * @param source - The build context, or a target.
   * @param account - The caller to ask about.
   * @param functionName - The pool function.
   * @returns Whether the call is immediately permitted.
   */
  export function readCanCallPool(
    target: EthereumOutpostTarget,
    account: string,
    functionName: PoolFunction
  ): Promise<boolean>
  export function readCanCallPool<C extends ClusterBuildContext>(
    ctx: C,
    account: string,
    functionName: PoolFunction
  ): Promise<boolean>
  export async function readCanCallPool<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    account: string,
    functionName: PoolFunction
  ): Promise<boolean> {
    const pool = loadSyndicationPool(source, providerOf(source)),
      manager = loadOutpostManagerAuthority(source, providerOf(source)),
      authority = await pool.authority()
    // The pool must answer to THIS manager, or its answer is about another pool.
    Assert.ok(
      ethers.getAddress(authority) ===
        ethers.getAddress(await manager.getAddress()),
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
    /** Durable handle of the depositing holder's persisted wallet. */
    readonly walletName: string
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
   * @param walletName - Durable handle of the holder's persisted wallet.
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
    walletName: string,
    amountWei: bigint
  ): ClusterBuildStep<C, DepositLiqEthInput> {
    return ClusterBuildStep.create<C, DepositLiqEthInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.DepositLiqEthInput",
        walletName,
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
    const holder = EthereumFundingTool.signer(ctx, input.walletName)
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
  export function readSyndicatedPrincipal(
    target: EthereumOutpostTarget
  ): Promise<bigint>
  export function readSyndicatedPrincipal<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<bigint>
  export async function readSyndicatedPrincipal<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>
  ): Promise<bigint> {
    return loadSyndicationPool(source, providerOf(source)).syndicatedPrincipal()
  }

  /**
   * The liqETH `syndicator` has syndicated into the pool, in wei — the sum of
   * `nativeTaken` over its `Syndicated` events, the pool's only per-account
   * record (the depot is the ledger of a syndicated position; the pool keeps
   * no per-holder balance). `0n` for an address that never syndicated. A
   * READ, scanned from {@link EventScanFromBlock} by the event's indexed
   * `syndicator` topic.
   *
   * @param source - The build context, or a target.
   * @param syndicator - The address that sent the syndications.
   * @returns The syndicated total, in wei.
   * @throws If a `Syndicated` log cannot be decoded.
   */
  export function readSyndicatedPosition(
    target: EthereumOutpostTarget,
    syndicator: string
  ): Promise<bigint>
  export function readSyndicatedPosition<C extends ClusterBuildContext>(
    ctx: C,
    syndicator: string
  ): Promise<bigint>
  export async function readSyndicatedPosition<C extends ClusterBuildContext>(
    source: EthereumOutpostSource<C>,
    syndicator: string
  ): Promise<bigint> {
    const pool = loadSyndicationPool(source, providerOf(source)),
      events = await pool.queryFilter(
        pool.filters[PoolEvent.Syndicated](syndicator),
        EventScanFromBlock
      )
    return events
      .map(event => {
        Assert.ok(
          event instanceof ethers.EventLog,
          `EthereumSyndicationTool: an undecoded ${PoolEvent.Syndicated} log in tx ${event.transactionHash}`
        )
        return event
      })
      .reduce((total, event) => total + BigInt(event.args.nativeTaken), 0n)
  }

  // ── Step: liqETH allowance for the pool (`approve`) ──────────────────────

  /** Input for {@link planApproveLiqEth} — one `approve` write. */
  export interface ApproveLiqEthInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.ApproveLiqEthInput"
    /** Durable handle of the approving holder's persisted wallet. */
    readonly walletName: string
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
   * @param walletName - Durable handle of the holder's persisted wallet.
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
    walletName: string,
    amount: bigint
  ): ClusterBuildStep<C, ApproveLiqEthInput> {
    return ClusterBuildStep.create<C, ApproveLiqEthInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.ApproveLiqEthInput",
        walletName,
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
    const holder = EthereumFundingTool.signer(ctx, input.walletName),
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
    /** Durable handle of the syndicating holder's persisted wallet (the sender). */
    readonly walletName: string
    /** Wei to syndicate. */
    readonly amount: bigint
    /**
     * The 33-byte compressed key the depot parks the syndication against, `0x`
     * hex — the holder's own when absent, carried as given when a flow
     * presents another.
     */
    readonly compressedPubkey?: string
  }

  /**
   * A single `SyndicationPool.syndicate(amount, compressedPubkey)`. The pool
   * takes the liqETH (it needs the allowance of {@link planApproveLiqEth}) and
   * queues `SYNDICATE_LIQ`; it refuses an amount above its per-transfer
   * maximum, a key that does not derive to the sender, and any call while
   * paused. Without `compressedPubkey` the holder's own key is sent
   * (`EthereumFundingTool.compressedPubkey`); a flow presenting a wrong one
   * passes it explicitly.
   *
   * @param actor - The narrative subject (the holder).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param walletName - Durable handle of the holder's persisted wallet.
   * @param amount - Wei to syndicate.
   * @param compressedPubkey - A compressed key to present instead of the holder's own.
   * @returns The definition step.
   */
  export function planSyndicate<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    walletName: string,
    amount: bigint,
    compressedPubkey?: string
  ): ClusterBuildStep<C, SyndicateInput> {
    return ClusterBuildStep.create<C, SyndicateInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.SyndicateInput",
        walletName,
        amount,
        ...(compressedPubkey != null ? { compressedPubkey } : {})
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
    const holder = EthereumFundingTool.signer(ctx, input.walletName),
      {
        compressedPubkey = EthereumFundingTool.compressedPubkey(
          ctx,
          input.walletName
        )
      } = input
    await send(
      holder,
      syndicateRequest(
        loadSyndicationPool(ctx, holder),
        input.amount,
        compressedPubkey
      ),
      "EthereumSyndicationTool.planSyndicate"
    )
  }

  // ── Step: donate liqETH to the pool (an ERC-20 transfer) ─────────────────

  /** Input for {@link planDonateToPool} — one liqETH transfer into the pool. */
  export interface DonateToPoolInput extends StepInput {
    readonly kind: "EthereumSyndicationTool.DonateToPoolInput"
    /** Durable handle of the donor's persisted wallet. */
    readonly walletName: string
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
   * @param walletName - Durable handle of the donor's persisted wallet.
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
    walletName: string,
    amount: bigint
  ): ClusterBuildStep<C, DonateToPoolInput> {
    return ClusterBuildStep.create<C, DonateToPoolInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.DonateToPoolInput",
        walletName,
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
    const donor = EthereumFundingTool.signer(ctx, input.walletName),
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
    /** Durable handle of the signer's wallet — the panic account the deploy config named. */
    readonly walletName: string
    /** `true` sends `pause()`, `false` sends `unpause()`. */
    readonly paused: boolean
  }

  /**
   * A single `SyndicationPool.pause()` or `unpause()`, signed by the panic
   * account (the persisted {@link EthereumWallet.PanicWalletName} wallet,
   * carried on the input so the Report names the signer). While paused, `syndicate` and
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
        walletName: EthereumWallet.PanicWalletName,
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
    const panic = EthereumFundingTool.signer(ctx, input.walletName)
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
    /** Durable handle of the caller's persisted wallet (any account may crank). */
    readonly walletName: string
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
   * @param walletName - Durable handle of the caller's persisted wallet.
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
    walletName: string,
    requestId: bigint
  ): ClusterBuildStep<C, PayPendingDesyndicationInput> {
    return ClusterBuildStep.create<C, PayPendingDesyndicationInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumSyndicationTool.PayPendingDesyndicationInput",
        walletName,
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
    const caller = EthereumFundingTool.signer(ctx, input.walletName)
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
