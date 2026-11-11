/**
 * BatchOperatorFundingTool — the pre-launch FUNDING of a cluster's bootstrap
 * batch operators on BOTH outposts (`wire-cluster-tool fund-batch-operators`):
 * for each operator whose keys `create-batch-operator-keys` pre-created, ADOPT
 * those keys (adopt-ONLY — a missing key fails, never silently minting a
 * replacement the funding would then bind to), check the operator's native
 * balance on each outpost covers `stake + reserve`, and STAKE the configured
 * amount so the launch snapshot carries the operator's position:
 *
 * - Ethereum, PRE-launch — ONE `Depositor.depositAndStake{value: stake}`
 *   through {@link EthereumPreLaunchStakingTool}, signed by the operator's EM
 *   key (`keyPairUtils.ethereumSigner`, so a KMS-custodied key signs remotely).
 * - Ethereum, POST-launch — `DepositManager.deposit{value: stake}` → liqETH
 *   `approve(SyndicationPool)` → `SyndicationPool.syndicate(liqETH,
 *   compressedPubkey)`, the post-launch user path of
 *   {@link EthereumSyndicationTool}; one transaction per write.
 * - Solana — `sol_to_liqsol(stake)` then `synd(all minted liqSOL)` signed by
 *   the operator's ED keypair, in the account form of the outpost's launch
 *   state ({@link SolanaLiqSyndicationTool.syndAccounts}).
 *
 * Decision rules, read ON CHAIN before any write ({@link assertFundable}):
 * Ethereum is pre-launch while the address book records the staking proxy
 * and its `dDay()` is false; `dDay()` true, or no staking proxy at all, is
 * post-launch (the pool must then be recorded and unpaused); an open refund
 * window or a paused staking contract refuses. Solana funds in `PreLaunch`
 * and `PostLaunch`; `Launching` (the frozen snapshot window) and `Refund` are
 * refused, as are a frozen (emergency stop) or paused surface.
 *
 * Every precondition of EVERY operator (balances, launch states, per-transfer
 * maxima, the chain id) is checked before the first transaction, so the
 * common failure class never leaves one operator funded and the next not.
 * The writes then run operator by operator, Ethereum then Solana; the first
 * write failure stops the run and is reported with every receipt that landed
 * before it. Nothing is idempotent: a re-run stakes again.
 *
 * A cluster-less surface — the `create-batch-operator-keys` departure: no
 * `ClusterBuildContext`, no Step, no Report. The reads and builds go through
 * the SAME tool primitives the flow Steps use, addressed by the outpost
 * targets ({@link EthereumOutpostTarget} / {@link SolanaOutpostTarget}) an
 * `ExternalOutpostConfig` composes.
 */

import Assert from "node:assert"

import { ethers } from "ethers"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import { identity } from "lodash"
import { match, P } from "ts-pattern"
import { KeyType, SlugName } from "@wireio/sdk-core"
import { OperatorType, TokenAmount } from "@wireio/opp-typescript-models"
import {
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type KeyCustodySettings
} from "@wireio/cluster-tool-shared"

import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { getLogger } from "../../logging/Logger.js"
import type { OperatorAccount } from "../../orchestration/outputs/OperatorAccount.js"
import { KeySteps } from "../../orchestration/steps/KeySteps.js"
import { eachSeries, mapSeries } from "../../utils/asyncUtils.js"
import {
  clearNonceCache,
  resolveLatestNonce
} from "../../utils/ethereumUtils.js"
import {
  ethereumCompressedPubkey,
  ethereumSigner,
  solanaKeypair,
  solanaNativePublicKey
} from "../../utils/keyPairUtils.js"
import { EthereumOutpostTarget } from "../ethereum/EthereumOutpostTarget.js"
import { EthereumPreLaunchStakingTool } from "../ethereum/EthereumPreLaunchStakingTool.js"
import { EthereumSyndicationTool } from "../ethereum/EthereumSyndicationTool.js"
import { WireState } from "../solana/SolanaAnchorEnumTool.js"
import { SolanaLiqSyndicationTool } from "../solana/SolanaLiqSyndicationTool.js"
import type { SolanaOutpostTarget } from "../solana/SolanaOutpostTarget.js"

const log = getLogger(__filename)

export namespace BatchOperatorFundingTool {
  /** Wei per depot unit of ETH — `10^(18 − NATIVE_TOKEN_PRECISION)`. */
  export const WeiPerDepotUnit =
    ethers.WeiPerEther / 10n ** BigInt(Constants.NATIVE_TOKEN_PRECISION)
  /** Lamports per depot unit of SOL — `10^(9 − NATIVE_TOKEN_PRECISION)`, i.e. 1. */
  export const LamportsPerDepotUnit =
    BigInt(LAMPORTS_PER_SOL) / 10n ** BigInt(Constants.NATIVE_TOKEN_PRECISION)
  /** Confirmations every Ethereum write waits for — the syndication tool's. */
  export const Confirmations = EthereumSyndicationTool.Confirmations
  /** The listing's JSON indentation (the stdout document is for humans AND `jq`). */
  export const ListingIndent = 2

  /** The on-chain write a receipt records. Identity enum (value === key). */
  export enum FundingAction {
    /** Ethereum pre-launch: `Depositor.depositAndStake{value}`. */
    depositAndStake = "depositAndStake",
    /** Ethereum post-launch: `DepositManager.deposit{value}` (ETH → liqETH). */
    deposit = "deposit",
    /** Ethereum post-launch: liqETH `approve(SyndicationPool, amount)`. */
    approve = "approve",
    /** Ethereum post-launch: `SyndicationPool.syndicate(amount, compressedPubkey)`. */
    syndicate = "syndicate",
    /** Solana: `sol_to_liqsol(lamports)` (SOL → liqSOL). */
    solToLiqsol = "solToLiqsol",
    /** Solana: `synd(amount)` into the outpost-owned pool. */
    synd = "synd"
  }

  /**
   * Which Ethereum staking surface is live, decided from the chain
   * ({@link resolveEthereumLaunchPhase}). Identity enum (value === key).
   */
  export enum EthereumLaunchPhase {
    /** The staking proxy is recorded and `dDay()` is false: `depositAndStake`. */
    preLaunch = "preLaunch",
    /** `dDay()` is true, or no staking proxy is recorded: the `SyndicationPool` path. */
    postLaunch = "postLaunch"
  }

  /**
   * What each operator stakes and must keep, per outpost native token, in
   * DEPOT units — the resolved `batchOperatorUnderwriting.stake` / `.reserve`.
   */
  export interface Allocation {
    /** The native amount staked on each outpost (one entry per native token). */
    readonly stake: readonly TokenAmount[]
    /** The native amount kept on each outpost for gas / fees (one entry per native token). */
    readonly reserve: readonly TokenAmount[]
  }

  /** The two outposts a launch funds its operators on. */
  export interface Targets {
    /** The Ethereum outpost. */
    readonly ethereum: EthereumOutpostTarget
    /** The Solana outpost. */
    readonly solana: SolanaOutpostTarget
  }

  /** One landed transaction — a row of the listing `fund-batch-operators` prints. */
  export interface Receipt {
    /** The batch operator's durable handle (`batchop.a`). */
    readonly label: string
    /** The outpost chain the write landed on. */
    readonly chain: Constants.OutpostChainCodename
    /** The write. */
    readonly action: FundingAction
    /** The transaction hash (Ethereum) or signature (Solana). */
    readonly transaction: string
    /**
     * The write's amount in chain-native base units: wei for
     * `depositAndStake` / `deposit`, liqETH wei for `approve` / `syndicate`,
     * lamports for `solToLiqsol`, liqSOL base units for `synd`.
     */
    readonly amount: bigint
  }

  /** The first write failure of a run — which operator, on which chain, and why. */
  export interface Failure {
    /** The batch operator's durable handle. */
    readonly label: string
    /** The outpost chain the failed write targeted. */
    readonly chain: Constants.OutpostChainCodename
    /** The error the write rejected with. */
    readonly error: Error
  }

  /** What a run produced: every landed receipt, and the failure that stopped it if one did. */
  export interface Outcome {
    /** Every transaction that landed, in submission order. */
    readonly receipts: Receipt[]
    /** The failure that stopped the run; absent when every operator was funded on every outpost. */
    readonly failure?: Failure
  }

  /** An {@link Allocation} converted to chain-native units. */
  export interface NativeAllocation {
    /** The Ethereum stake, in wei. */
    readonly stakeWei: bigint
    /** The Ethereum gas reserve, in wei. */
    readonly reserveWei: bigint
    /** The Solana stake, in lamports. */
    readonly stakeLamports: bigint
    /** The Solana fee + rent reserve, in lamports. */
    readonly reserveLamports: bigint
  }

  /**
   * Everything {@link assertFundable} establishes before the first write, so
   * the writes make no decision of their own.
   */
  export interface FundingPreflight {
    /** The allocation in chain-native units. */
    readonly native: NativeAllocation
    /** Which Ethereum staking surface is live. */
    readonly ethereumPhase: EthereumLaunchPhase
    /** The Solana outpost's launch state (`preLaunch` or `postLaunch`). */
    readonly wireState: WireState
  }

  /** One chain's funding of one operator, for the stop-at-first-failure walk. */
  interface FundingLeg {
    readonly chain: Constants.OutpostChainCodename
    readonly fund: () => Promise<Receipt[]>
  }

  // ── key adoption ──────────────────────────────────────────────────────────

  /**
   * Adopt every batch operator's pre-created keys — wire K1, solana ED and
   * ethereum EM, through the SAME seam the bootstrap uses
   * (`KeySteps.adoptOrCreateSignatureProviderKey`), under the ADOPT-ONLY
   * policy: a key the custody store does not hold fails naming its id, and is
   * never created — funding a key this run minted would bind real value to an
   * identity no launch adopts. Refuses a KEY / KIOD provider (no custody store
   * to adopt from) and a label that is not a bootstrap batch operator's.
   *
   * @param settings - The resolved key-custody settings (SSM, optionally with KMS).
   * @param labels - The batch operators' durable handles (`Constants.batchOperatorLabels`).
   * @param keyContext - The key-generation tooling (unused under adopt-only; the seam requires it).
   * @returns The identities, in `labels` order.
   */
  export async function adoptOperators(
    settings: KeyCustodySettings,
    labels: readonly string[],
    keyContext: KeyGenerator.Context
  ): Promise<OperatorAccount[]> {
    Assert.ok(
      settings.signatureProvider.type === SignatureProviderType.SSM,
      `BatchOperatorFundingTool: funding requires an SSM signature provider (got ${settings.signatureProvider.type}) — a KEY / KIOD cluster has no custody store to adopt the pre-created keys from`
    )
    labels.forEach(label =>
      Assert.ok(
        Constants.isBatchOperatorLabel(label),
        `BatchOperatorFundingTool: "${label}" is not a bootstrap batch-operator label (${Constants.BatchOperatorLabelPrefix}<letter>)`
      )
    )
    const adopting: KeyCustodySettings = {
      ...settings,
      signatureProvider: {
        ...settings.signatureProvider,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOnly
      }
    }
    return mapSeries(labels, async label => {
      const [wire, solana, ethereum] = await Promise.all([
        KeySteps.adoptOrCreateSignatureProviderKey(
          adopting,
          KeyType.K1,
          label,
          keyContext
        ),
        KeySteps.adoptOrCreateSignatureProviderKey(
          adopting,
          KeyType.ED,
          label,
          keyContext
        ),
        KeySteps.adoptOrCreateSignatureProviderKey(
          adopting,
          KeyType.EM,
          label,
          keyContext
        )
      ])
      log.info(
        `[fund-batch-operators] ${label} — adopted ETH ${ethereum.address}, SOL ${solanaNativePublicKey(solana)}`
      )
      return {
        label,
        publicationLabel: label,
        account: label,
        type: OperatorType.BATCH,
        wire,
        ethereum,
        solana
      }
    })
  }

  // ── amounts (pure value helpers) ──────────────────────────────────────────

  /**
   * The amount `amounts` names for the native token `codename`, in depot
   * units.
   *
   * @param amounts - A stake or reserve list.
   * @param codename - The native token codename (`ETH` / `SOL`).
   * @returns The amount.
   * @throws If the list names no amount for the token.
   */
  export function amountFor(
    amounts: readonly TokenAmount[],
    codename: string
  ): bigint {
    const tokenCode = BigInt(SlugName.from(codename)),
      found = amounts.find(amount => amount.tokenCode === tokenCode)
    Assert.ok(
      found != null,
      `BatchOperatorFundingTool: no amount is configured for ${codename} (configured: ${amounts
        .map(amount => SlugName.toString(Number(amount.tokenCode)))
        .join(", ")})`
    )
    return found.amount
  }

  /**
   * A depot-unit amount in chain-native units.
   *
   * @param units - The amount, in depot units ({@link Constants.NATIVE_TOKEN_PRECISION}).
   * @param nativePerDepotUnit - Chain-native base units per depot unit ({@link WeiPerDepotUnit} / {@link LamportsPerDepotUnit}).
   * @returns The chain-native amount.
   */
  export function nativeUnits(units: bigint, nativePerDepotUnit: bigint): bigint {
    return units * nativePerDepotUnit
  }

  /**
   * An allocation in chain-native units — wei on Ethereum, lamports on Solana.
   *
   * @param allocation - The stake + reserve, in depot units.
   * @returns The native allocation.
   */
  export function nativeAllocation(allocation: Allocation): NativeAllocation {
    const { stake, reserve } = allocation
    return {
      stakeWei: nativeUnits(
        amountFor(stake, Constants.ETH_TOKEN_CODENAME),
        WeiPerDepotUnit
      ),
      reserveWei: nativeUnits(
        amountFor(reserve, Constants.ETH_TOKEN_CODENAME),
        WeiPerDepotUnit
      ),
      stakeLamports: nativeUnits(
        amountFor(stake, Constants.SOL_TOKEN_CODENAME),
        LamportsPerDepotUnit
      ),
      reserveLamports: nativeUnits(
        amountFor(reserve, Constants.SOL_TOKEN_CODENAME),
        LamportsPerDepotUnit
      )
    }
  }

  /** The Solana wallet of an operator's ED pair, read off its stored public key (no secret). */
  function solanaWallet(operator: OperatorAccount): PublicKey {
    return new PublicKey(solanaNativePublicKey(operator.solana))
  }

  /** An operator whose both outpost keys were adopted — the precondition of every check and write. */
  function assertOutpostKeys(operator: OperatorAccount): OperatorAccount {
    Assert.ok(
      operator.ethereum != null && operator.solana != null,
      `BatchOperatorFundingTool: ${operator.label} carries no ${operator.ethereum == null ? "ethereum" : "solana"} key`
    )
    return operator
  }

  // ── preflight (reads only — nothing here writes) ──────────────────────────

  /**
   * Which Ethereum staking surface is live, decided from the chain: no
   * staking proxy in the address book → post-launch; a recorded proxy whose
   * `dDay()` is set → post-launch (the pre-launch set is closed for good);
   * otherwise pre-launch — unless the refund window is open or the proxy is
   * paused, which refuse outright. A READ.
   *
   * @param target - The Ethereum outpost.
   * @returns The phase.
   * @throws If the pre-launch proxy refuses every stake (refund open, paused).
   */
  export async function resolveEthereumLaunchPhase(
    target: EthereumOutpostTarget
  ): Promise<EthereumLaunchPhase> {
    if (
      !EthereumPreLaunchStakingTool.hasStakingContract(target.outpostAddresses)
    ) {
      log.info(
        `[fund-batch-operators] the Ethereum address book records no ${EthereumPreLaunchStakingTool.StakingContractName} — a post-launch outpost; staking through the SyndicationPool`
      )
      return EthereumLaunchPhase.postLaunch
    }
    const gate = await EthereumPreLaunchStakingTool.readLaunchGate(target)
    Assert.ok(
      !gate.refundActive,
      `BatchOperatorFundingTool: the Ethereum ${EthereumPreLaunchStakingTool.StakingContractName}'s refund window is open — nothing can be staked`
    )
    if (gate.dDay) {
      log.info(
        `[fund-batch-operators] the Ethereum ${EthereumPreLaunchStakingTool.StakingContractName} is past D-Day — staking through the SyndicationPool`
      )
      return EthereumLaunchPhase.postLaunch
    }
    Assert.ok(
      !gate.paused,
      `BatchOperatorFundingTool: the Ethereum ${EthereumPreLaunchStakingTool.StakingContractName} is paused — nothing can be staked`
    )
    return EthereumLaunchPhase.preLaunch
  }

  /**
   * The Solana outpost's launch state, asserted fundable: `Launching` (the
   * frozen snapshot window, where `synd` is refused by the program) and
   * `Refund` are refused, as are a frozen (emergency stop) or paused surface.
   * A READ.
   *
   * @param target - The Solana outpost.
   * @returns `preLaunch` or `postLaunch`.
   * @throws For every other state, and for a frozen or paused surface.
   */
  export async function resolveWireState(
    target: SolanaOutpostTarget
  ): Promise<WireState> {
    const wireState = await SolanaLiqSyndicationTool.readWireState(target)
    Assert.ok(
      wireState !== WireState.launching,
      `BatchOperatorFundingTool: the Solana outpost is ${WireState.launching} — the frozen snapshot window refuses every synd; fund before the freeze, or once the outpost is ${WireState.postLaunch}`
    )
    Assert.ok(
      wireState !== WireState.refund,
      `BatchOperatorFundingTool: the Solana outpost is in ${WireState.refund} — nothing can be staked`
    )
    Assert.ok(
      !(await SolanaLiqSyndicationTool.readGlobalStateFrozen(target)),
      "BatchOperatorFundingTool: the Solana outpost is frozen (emergency stop) — synd is refused"
    )
    Assert.ok(
      !(await SolanaLiqSyndicationTool.readGlobalStatePaused(target)),
      "BatchOperatorFundingTool: the Solana liqsol surface is paused — every user instruction is refused"
    )
    return wireState
  }

  /**
   * An external config that names the LIQSOL mint must name the ONE the
   * liqsol-token program derives — a differing mint means the config and the
   * wire-solana build describe different deployments.
   */
  function assertLiqsolMint(target: SolanaOutpostTarget): void {
    const liqsolCode = BigInt(SlugName.from(Constants.LIQSOL_CODENAME)),
      recorded = (target.mints ?? []).find(
        mint => BigInt(mint.code) === liqsolCode
      )
    if (recorded == null) return
    const derived = SolanaLiqSyndicationTool.deriveBasePdas(
      target.solanaPath,
      target.programId
    ).liqsolMint.toBase58()
    Assert.strictEqual(
      recorded.mint,
      derived,
      `BatchOperatorFundingTool: the external config's ${Constants.LIQSOL_CODENAME} mint ${recorded.mint} is not the liqsol-token mint the wire-solana build derives (${derived})`
    )
  }

  /** The post-launch Ethereum surface the writes need: the pool recorded, unpaused, and above the stake. */
  async function assertPostLaunchEthereum(
    target: EthereumOutpostTarget,
    native: NativeAllocation
  ): Promise<void> {
    Assert.ok(
      target.outpostAddresses[
        EthereumSyndicationTool.SyndicationPoolContractName
      ] != null,
      `BatchOperatorFundingTool: the Ethereum address book records neither a ${EthereumPreLaunchStakingTool.StakingContractName} (pre-launch) nor a ${EthereumSyndicationTool.SyndicationPoolContractName} (post-launch) — nothing to stake through`
    )
    Assert.ok(
      target.liqEthAddresses != null,
      "BatchOperatorFundingTool: the post-launch path needs the outpost's liqEthAddresses (DepositManager + LiqEthToken)"
    )
    Assert.ok(
      !(await EthereumSyndicationTool.readPaused(target)),
      "BatchOperatorFundingTool: the Ethereum SyndicationPool is paused — syndicate is refused"
    )
    const { maxSyndicationPerTransfer } =
      await EthereumSyndicationTool.readPoolConfiguration(target)
    Assert.ok(
      maxSyndicationPerTransfer >= native.stakeWei,
      `BatchOperatorFundingTool: the Ethereum stake ${native.stakeWei} wei exceeds the pool's maxSyndicationPerTransfer ${maxSyndicationPerTransfer}`
    )
  }

  /** The Solana per-transfer maximum covers the stake (liqSOL mints 1:1 with the lamports). */
  async function assertSolanaSyndicationMaximum(
    target: SolanaOutpostTarget,
    native: NativeAllocation
  ): Promise<void> {
    const { maxSyndicationPerTransfer } =
      await SolanaLiqSyndicationTool.readGlobalConfig(target)
    Assert.ok(
      maxSyndicationPerTransfer >= native.stakeLamports,
      `BatchOperatorFundingTool: the Solana stake ${native.stakeLamports} lamports exceeds global_config.max_syndication_per_transfer ${maxSyndicationPerTransfer}`
    )
  }

  /** The operator holds `stake + reserve` on each outpost. */
  async function assertBalances(
    operator: OperatorAccount,
    native: NativeAllocation,
    targets: Targets
  ): Promise<void> {
    const { ethereum, solana } = assertOutpostKeys(operator),
      ethereumBalance = await targets.ethereum.provider.getBalance(
        ethereum.address
      ),
      ethereumRequired = native.stakeWei + native.reserveWei
    Assert.ok(
      ethereumBalance >= ethereumRequired,
      `BatchOperatorFundingTool: ${operator.label}'s Ethereum balance ${ethereumBalance} wei at ${ethereum.address} is below stake + reserve ${ethereumRequired} wei`
    )
    const wallet = solanaWallet(operator),
      lamports = BigInt(await targets.solana.connection.getBalance(wallet)),
      solanaRequired = native.stakeLamports + native.reserveLamports
    Assert.ok(
      lamports >= solanaRequired,
      `BatchOperatorFundingTool: ${operator.label}'s Solana balance ${lamports} lamports at ${wallet.toBase58()} is below stake + reserve ${solanaRequired} lamports`
    )
    log.info(
      `[fund-batch-operators] ${operator.label} holds ${ethereumBalance} wei (needs ${ethereumRequired}) and ${lamports} lamports (needs ${solanaRequired}) — ${solanaNativePublicKey(solana)}`
    )
  }

  /**
   * Establish every precondition of the run BEFORE the first write — the
   * chain id behind the Ethereum endpoint, the LIQSOL mint, both launch
   * states, both per-transfer maxima, and every operator's balance on both
   * outposts — so a refusal (the common failure class) never leaves one
   * operator funded and the next not. Reads only.
   *
   * @param operators - The adopted identities.
   * @param allocation - The stake + reserve, in depot units.
   * @param targets - The two outposts.
   * @returns What the writes run against.
   * @throws On the first unmet precondition, naming it.
   */
  export async function assertFundable(
    operators: readonly OperatorAccount[],
    allocation: Allocation,
    targets: Targets
  ): Promise<FundingPreflight> {
    Assert.ok(operators.length > 0, "BatchOperatorFundingTool: no operator to fund")
    const native = nativeAllocation(allocation)
    Assert.ok(
      native.stakeWei > 0n && native.stakeLamports > 0n,
      "BatchOperatorFundingTool: every stake must be positive"
    )
    await EthereumOutpostTarget.assertChainId(targets.ethereum)
    assertLiqsolMint(targets.solana)
    const ethereumPhase = await resolveEthereumLaunchPhase(targets.ethereum)
    if (ethereumPhase === EthereumLaunchPhase.postLaunch) {
      await assertPostLaunchEthereum(targets.ethereum, native)
    }
    const wireState = await resolveWireState(targets.solana)
    await assertSolanaSyndicationMaximum(targets.solana, native)
    await eachSeries(operators, operator =>
      assertBalances(operator, native, targets)
    )
    return { native, ethereumPhase, wireState }
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /**
   * Send `request` from `signer` with an explicitly drawn nonce and wait for it
   * to mine — the ONE Ethereum submission path of this tool. A failed send
   * drops the signer's cached nonce so the next draw re-seeds from the chain.
   *
   * @param signer - The connected signer.
   * @param request - The call to send.
   * @param label - What is being sent, for the failure message.
   * @returns The mined transaction's hash.
   * @throws If the transaction reverts.
   */
  async function sendEthereum(
    signer: ethers.Signer,
    request: ethers.TransactionRequest,
    label: string
  ): Promise<string> {
    const nonce = await resolveLatestNonce(signer)
    try {
      const response = await signer.sendTransaction({ ...request, nonce }),
        receipt = await response.wait(Confirmations)
      Assert.ok(
        receipt?.status === 1,
        `${label}: reverted (status=${receipt?.status ?? "null"})`
      )
      return receipt.hash
    } catch (error) {
      clearNonceCache(await signer.getAddress())
      throw error
    }
  }

  /** One receipt row. */
  function receipt(
    label: string,
    chain: Constants.OutpostChainCodename,
    action: FundingAction,
    transaction: string,
    amount: bigint
  ): Receipt {
    log.info(
      `[fund-batch-operators] ${label} ${chain} ${action} ${amount} → ${transaction}`
    )
    return { label, chain, action, transaction, amount }
  }

  /** Ethereum pre-launch: ONE `depositAndStake{value: stake}`. */
  async function stakePreLaunchEthereum(
    operator: OperatorAccount,
    signer: ethers.Signer,
    native: NativeAllocation,
    target: EthereumOutpostTarget
  ): Promise<Receipt[]> {
    const staking = EthereumPreLaunchStakingTool.loadStakingContract(
        target,
        signer
      ),
      hash = await sendEthereum(
        signer,
        EthereumPreLaunchStakingTool.depositAndStakeRequest(
          staking,
          native.stakeWei
        ),
        `fund-batch-operators ${operator.label} ${FundingAction.depositAndStake}`
      )
    return [
      receipt(
        operator.label,
        Constants.ETHEREUM_CHAIN_CODENAME,
        FundingAction.depositAndStake,
        hash,
        native.stakeWei
      )
    ]
  }

  /** Ethereum post-launch: `deposit{value}` → `approve(pool, minted)` → `syndicate(minted, compressedPubkey)`. */
  async function syndicatePostLaunchEthereum(
    operator: OperatorAccount,
    signer: ethers.Signer,
    native: NativeAllocation,
    target: EthereumOutpostTarget
  ): Promise<Receipt[]> {
    const { label } = operator,
      chain = Constants.ETHEREUM_CHAIN_CODENAME,
      depositManager = EthereumSyndicationTool.loadDepositManager(target, signer),
      liqEth = EthereumSyndicationTool.loadLiqEthToken(target, signer),
      pool = EthereumSyndicationTool.loadSyndicationPool(target, signer),
      poolAddress = await pool.getAddress(),
      depositHash = await sendEthereum(
        signer,
        EthereumSyndicationTool.depositLiqEthRequest(
          depositManager,
          native.stakeWei
        ),
        `fund-batch-operators ${label} ${FundingAction.deposit}`
      ),
      minted = await EthereumSyndicationTool.readLiqEthBalance(
        target,
        operator.ethereum.address
      )
    Assert.ok(
      minted > 0n,
      `BatchOperatorFundingTool: ${label} holds no liqETH after depositing ${native.stakeWei} wei`
    )
    const approveHash = await sendEthereum(
        signer,
        EthereumSyndicationTool.approveLiqEthRequest(liqEth, poolAddress, minted),
        `fund-batch-operators ${label} ${FundingAction.approve}`
      ),
      syndicateHash = await sendEthereum(
        signer,
        EthereumSyndicationTool.syndicateRequest(
          pool,
          minted,
          ethers.hexlify(ethereumCompressedPubkey(operator.ethereum))
        ),
        `fund-batch-operators ${label} ${FundingAction.syndicate}`
      )
    return [
      receipt(label, chain, FundingAction.deposit, depositHash, native.stakeWei),
      receipt(label, chain, FundingAction.approve, approveHash, minted),
      receipt(label, chain, FundingAction.syndicate, syndicateHash, minted)
    ]
  }

  /** Fund one operator on Ethereum, in the preflight's phase. */
  async function fundEthereum(
    operator: OperatorAccount,
    preflight: FundingPreflight,
    target: EthereumOutpostTarget
  ): Promise<Receipt[]> {
    const signer = await ethereumSigner(operator.ethereum, target.provider)
    return match(preflight.ethereumPhase)
      .with(EthereumLaunchPhase.preLaunch, () =>
        stakePreLaunchEthereum(operator, signer, preflight.native, target)
      )
      .with(EthereumLaunchPhase.postLaunch, () =>
        syndicatePostLaunchEthereum(operator, signer, preflight.native, target)
      )
      .exhaustive()
  }

  /**
   * Fund one operator on Solana: `sol_to_liqsol(stake)` — standing off the
   * runtime's epoch-rewards window exactly as the deposit Step does — then
   * `synd` of EVERY liqSOL the operator then holds, in the launch state's
   * account form.
   */
  async function fundSolana(
    operator: OperatorAccount,
    preflight: FundingPreflight,
    target: SolanaOutpostTarget
  ): Promise<Receipt[]> {
    const { label } = operator,
      chain = Constants.SOLANA_CHAIN_CODENAME,
      user = solanaKeypair(operator.solana),
      { stakeLamports } = preflight.native,
      ephemeralStakeSeed = SolanaLiqSyndicationTool.nextEphemeralStakeSeed(label),
      depositLabel = `fund-batch-operators ${label} ${FundingAction.solToLiqsol}`
    let depositSignature: string = null
    await SolanaLiqSyndicationTool.waitForEpochRewardsIdle(target, depositLabel)
    await SolanaLiqSyndicationTool.submitWithEpochRewardsRetry(
      target,
      depositLabel,
      async () => {
        depositSignature = await SolanaLiqSyndicationTool.submit(
          target,
          await SolanaLiqSyndicationTool.depositForLiqsolTransaction(
            target,
            user,
            stakeLamports,
            ephemeralStakeSeed
          ),
          user,
          depositLabel
        )
      }
    )
    const minted = await SolanaLiqSyndicationTool.readLiqsolBalanceOf(
      target,
      user.publicKey
    )
    Assert.ok(
      minted > 0n,
      `BatchOperatorFundingTool: ${label} holds no liqSOL after depositing ${stakeLamports} lamports`
    )
    const syndSignature = await SolanaLiqSyndicationTool.submit(
      target,
      await SolanaLiqSyndicationTool.syndTransaction(
        target,
        user,
        minted,
        preflight.wireState
      ),
      user,
      `fund-batch-operators ${label} ${FundingAction.synd}`
    )
    return [
      receipt(label, chain, FundingAction.solToLiqsol, depositSignature, stakeLamports),
      receipt(label, chain, FundingAction.synd, syndSignature, minted)
    ]
  }

  /** Run one leg, appending its receipts; a rejection becomes the run's {@link Failure}. */
  async function fundLeg(
    operator: OperatorAccount,
    leg: FundingLeg,
    receipts: Receipt[]
  ): Promise<Failure> {
    return leg.fund().then(
      legReceipts => {
        receipts.push(...legReceipts)
        return null
      },
      (error: Error) => {
        log.error(
          `[fund-batch-operators] ${operator.label} on ${leg.chain} FAILED: ${error.message}`
        )
        return { label: operator.label, chain: leg.chain, error }
      }
    )
  }

  /** Fund one operator, Ethereum then Solana, stopping at the first failed leg. */
  async function fundOperator(
    operator: OperatorAccount,
    preflight: FundingPreflight,
    targets: Targets,
    receipts: Receipt[]
  ): Promise<Failure> {
    const legs: FundingLeg[] = [
      {
        chain: Constants.ETHEREUM_CHAIN_CODENAME,
        fund: () => fundEthereum(operator, preflight, targets.ethereum)
      },
      {
        chain: Constants.SOLANA_CHAIN_CODENAME,
        fund: () => fundSolana(operator, preflight, targets.solana)
      }
    ]
    return legs.reduce<Promise<Failure>>(
      async (previous, leg) =>
        (await previous) ?? fundLeg(operator, leg, receipts),
      Promise.resolve(null)
    )
  }

  /**
   * Fund every operator on both outposts: {@link assertFundable} first (a
   * refusal there writes nothing), then operator by operator, Ethereum then
   * Solana, one transaction per write, each awaited for its receipt. The first
   * write failure stops the run; what landed before it is returned either way.
   *
   * @param operators - The adopted identities ({@link adoptOperators}).
   * @param allocation - The stake + reserve, in depot units.
   * @param targets - The two outposts.
   * @returns Every landed receipt, plus the failure that stopped the run if one did.
   * @throws If a precondition is unmet — before any write.
   */
  export async function fund(
    operators: readonly OperatorAccount[],
    allocation: Allocation,
    targets: Targets
  ): Promise<Outcome> {
    const preflight = await assertFundable(operators, allocation, targets),
      receipts: Receipt[] = [],
      failure = await operators.reduce<Promise<Failure>>(
        async (previous, operator) =>
          (await previous) ??
          fundOperator(operator, preflight, targets, receipts),
        Promise.resolve(null)
      )
    return failure == null ? { receipts } : { receipts, failure }
  }

  // ── output ────────────────────────────────────────────────────────────────

  /** The JSON replacer that renders a bigint amount as its decimal string. */
  function listingReplacer(_key: string, value: unknown): unknown {
    return match(value)
      .with(P.bigint, amount => amount.toString())
      .otherwise(identity)
  }

  /**
   * The receipt listing as the JSON document `fund-batch-operators` prints on
   * stdout — amounts rendered as decimal strings (JSON has no bigint).
   *
   * @param receipts - The landed receipts.
   * @returns The JSON text.
   */
  export function toListingJson(receipts: readonly Receipt[]): string {
    return JSON.stringify(receipts, listingReplacer, ListingIndent)
  }
}
