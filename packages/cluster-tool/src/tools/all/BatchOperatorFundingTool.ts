/**
 * BatchOperatorFundingTool — the pre-launch FUNDING of a cluster's bootstrap
 * batch operators on BOTH outposts (`wire-cluster-tool fund-batch-operators`):
 * for each operator whose keys `create-batch-operator-keys` pre-created, ADOPT
 * its two outpost keys — the ethereum EM and the solana ED, the only keys that
 * sign here; the WIRE K1 signs no funding write and is never read — (adopt-ONLY:
 * a missing key fails, never silently minting a replacement the funding would
 * then bind to), check the operator's native balance on each outpost covers
 * what its leg still needs, and STAKE the configured amount so the launch
 * snapshot carries the operator's position:
 *
 * - Ethereum, PRE-launch — ONE `Depositor.depositAndStake{value: stake}`
 *   through {@link EthereumPreLaunchStakingTool}, signed by the operator's EM
 *   key (`keyPairUtils.ethereumSigner`, so a KMS-custodied key signs remotely).
 * - Ethereum, POST-launch — `DepositManager.deposit{value: stake}` → liqETH
 *   `approve(SyndicationPool, stake)` → `SyndicationPool.syndicate(stake,
 *   compressedPubkey)`, the post-launch user path of
 *   {@link EthereumSyndicationTool}; one transaction per write.
 * - Solana — `sol_to_liqsol(stake)` then `synd(stake)` signed by the
 *   operator's ED keypair, in the account form of the outpost's launch state
 *   ({@link SolanaLiqSyndicationTool.syndAccounts}).
 *
 * Every Ethereum write is estimated first and sent with its `gasLimit` set to
 * the estimate plus the allocation's `gasDriftMarginBps`, rounded up
 * ({@link addGasMargin}): state can move between the estimate and inclusion,
 * and a bare estimate can leave a nested call short of gas.
 *
 * Decision rules, read ON CHAIN before any write ({@link assertFundable}):
 * Ethereum is pre-launch while the address book records the staking proxy
 * and its `dDay()` is false; `dDay()` true, or no staking proxy at all, is
 * post-launch (the pool must then be recorded and unpaused); an open refund
 * window or a paused staking contract refuses. Solana funds in `PreLaunch`
 * and `PostLaunch`; `Launching` (the frozen snapshot window) and `Refund` are
 * refused, as are a frozen (emergency stop) or paused surface.
 *
 * A re-run is SAFE. The preflight reads every operator's position on each
 * outpost and plans each leg from it ({@link LegPlan}): an operator that
 * already holds staked liq there — Depositor shares (Ethereum, staked
 * pre-launch; past D-Day too), a `Syndicated` total on the pool (Ethereum
 * post-launch), a PreLaunch `OutpostAccount` stake or a PostLaunch `synd` in
 * its own history (Solana) — is SKIPPED on that outpost, reported as a
 * {@link Skip} and counted as funded. A leg that stopped half-way resumes
 * where it stopped: a liqETH / liqSOL balance that already covers the stake
 * skips the deposit, an allowance that already covers it skips the approve,
 * and every syndication is EXACTLY the configured stake — never the whole
 * balance, so a resumed leg can neither double the stake nor exceed the
 * per-transfer maximum the preflight checked against `stake`. The native
 * balance a leg requires follows its plan: `stake + reserve` while it still
 * deposits, the reserve alone once it does not.
 *
 * Post-launch, the positions are HISTORY, and that history counts from the
 * external outpost document's as-of markers: an operator's `Syndicated`
 * total on the pool is read from `ethereum.asOfBlock` on, its PostLaunch
 * `synd`s from `solana.asOfSlot` on — the finalized block / slot the document
 * was generated at. A position created before the marker is not this
 * campaign's and does not count as funded. A post-launch outpost whose
 * document carries no marker is refused in the preflight; a pre-launch one
 * never needs it (its positions are chain state, not history).
 *
 * Every precondition of EVERY operator (balances, launch states, per-transfer
 * maxima, the chain id, the positions and the plans) is established before
 * the first transaction, so the common failure class never leaves one
 * operator funded and the next not, and the writes make no decision of their
 * own. They then run operator by operator, Ethereum then Solana; the first
 * write failure stops the run and is reported with every receipt and skip
 * that preceded it.
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
import { TokenAmount } from "@wireio/opp-typescript-models"
import {
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type KeyCustodySettings
} from "@wireio/cluster-tool-shared"

import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { getLogger } from "../../logging/Logger.js"
import { KeySteps } from "../../orchestration/steps/KeySteps.js"
import type { EthereumKeyPair, SolanaKeyPair } from "../../types/KeyPair.js"
import type { SolanaSigner } from "../../types/SolanaSigner.js"
import { eachSeries, mapSeries } from "../../utils/asyncUtils.js"
import {
  clearNonceCache,
  resolveLatestNonce
} from "../../utils/ethereumUtils.js"
import {
  ethereumCompressedPubkey,
  ethereumSigner,
  solanaNativePublicKey,
  solanaSigner
} from "../../utils/keyPairUtils.js"
import { EthereumOutpostTarget } from "../ethereum/EthereumOutpostTarget.js"
import { EthereumPreLaunchStakingTool } from "../ethereum/EthereumPreLaunchStakingTool.js"
import { EthereumSyndicationTool } from "../ethereum/EthereumSyndicationTool.js"
import { WireState } from "../solana/SolanaAnchorEnumTool.js"
import { SolanaLiqSyndicationTool } from "../solana/SolanaLiqSyndicationTool.js"
import type { SolanaOutpostTarget } from "../solana/SolanaOutpostTarget.js"
import { WireSyndicationTool } from "../wire/WireSyndicationTool.js"

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
   * The writes that spend the operator's NATIVE balance — the ones a leg's
   * balance requirement adds the stake for; every other write spends gas or
   * fees from the reserve alone.
   */
  export const NativeDepositActions: ReadonlySet<FundingAction> = new Set([
    FundingAction.depositAndStake,
    FundingAction.deposit,
    FundingAction.solToLiqsol
  ])

  /** Why a leg wrote nothing. Identity enum (value === key). */
  export enum SkipReason {
    /** The operator already holds staked liq on the outpost — its launch position is there. */
    existingPosition = "existingPosition"
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
   * The identity the funding acts as — the batch operator's durable handle
   * and the two outpost keys that sign here. Nothing else of an
   * `OperatorAccount` is adopted: the WIRE K1 signs no funding write, so it is
   * never read from custody.
   */
  export interface FundedOperator {
    /** The batch operator's durable handle (`batchop.a`). */
    readonly label: string
    /** The ethereum EM key — signs every Ethereum write; its address holds the ETH. */
    readonly ethereum: EthereumKeyPair
    /** The solana ED key — signs every Solana write; its pubkey holds the SOL. */
    readonly solana: SolanaKeyPair
  }

  /**
   * What each operator stakes and must keep, per outpost native token, in
   * DEPOT units, and the gas headroom of its Ethereum writes — the resolved
   * `batchOperatorUnderwriting.stake` / `.reserve` / `.gasDriftMarginBps`.
   */
  export interface Allocation {
    /** The native amount staked on each outpost (one entry per native token). */
    readonly stake: readonly TokenAmount[]
    /** The native amount kept on each outpost for gas / fees (one entry per native token). */
    readonly reserve: readonly TokenAmount[]
    /**
     * The headroom every Ethereum write adds on top of its gas estimate, in basis
     * points ({@link addGasMargin}) — a non-negative integer.
     */
    readonly gasDriftMarginBps: number
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

  /** One leg skipped — a row of the listing beside the receipts; it counts as funded. */
  export interface Skip {
    /** The batch operator's durable handle (`batchop.a`). */
    readonly label: string
    /** The outpost chain the leg was skipped on. */
    readonly chain: Constants.OutpostChainCodename
    /** Why. */
    readonly reason: SkipReason
    /**
     * The existing position, in the units of the surface holding it: Depositor
     * shares (Ethereum, staked pre-launch), liqETH wei syndicated (Ethereum
     * post-launch), liqSOL base units (Solana).
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

  /** The document `fund-batch-operators` prints on stdout: every landed transaction and every skipped leg. */
  export interface Listing {
    /** Every transaction that landed, in submission order. */
    readonly receipts: readonly Receipt[]
    /** Every leg skipped for an existing position, in walk order. */
    readonly skips: readonly Skip[]
  }

  /** What a run produced: the listing, and the failure that stopped it if one did. */
  export interface Outcome extends Listing {
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
   * What one leg of one operator still has to write, decided from the chain
   * in the preflight: the operator's existing position on the outpost, and
   * the writes in submission order — empty exactly when the position is
   * positive (the leg is skipped); otherwise the deposit only while the liq
   * balance does not yet cover the stake, the approve only while the pool's
   * allowance does not, and the syndication always.
   */
  export interface LegPlan {
    /** The liq the operator already holds staked on the outpost ({@link Skip.amount}'s units); `0n` when none. */
    readonly position: bigint
    /** The writes the leg still needs, in submission order. */
    readonly writes: readonly FundingAction[]
  }

  /** Both legs of one operator. */
  export interface OperatorPlan {
    /** The operator the legs fund. */
    readonly operator: FundedOperator
    /** The Ethereum leg. */
    readonly ethereum: LegPlan
    /** The Solana leg. */
    readonly solana: LegPlan
  }

  /**
   * Everything {@link assertFundable} establishes before the first write, so
   * the writes make no decision of their own.
   */
  export interface FundingPreflight {
    /** The allocation in chain-native units. */
    readonly native: NativeAllocation
    /** The allocation's Ethereum gas headroom, in basis points ({@link Allocation.gasDriftMarginBps}). */
    readonly gasDriftMarginBps: number
    /** Which Ethereum staking surface is live. */
    readonly ethereumPhase: EthereumLaunchPhase
    /** The Solana outpost's launch state (`preLaunch` or `postLaunch`). */
    readonly wireState: WireState
    /** One plan per operator, in the operators' order. */
    readonly plans: readonly OperatorPlan[]
  }

  /**
   * One chain's funding of one operator, for the stop-at-first-failure walk:
   * appends each receipt to `receipts` AS IT LANDS (a later failure in the
   * leg loses none of them) and returns the skip when the leg wrote nothing.
   */
  interface FundingLeg {
    readonly chain: Constants.OutpostChainCodename
    readonly fund: (receipts: Receipt[]) => Promise<Skip>
  }

  /** What every Ethereum write of one operator resolves once. */
  interface EthereumWriteContext {
    readonly operator: FundedOperator
    /** The operator's EM key, connected to the outpost. */
    readonly signer: ethers.Signer
    readonly native: NativeAllocation
    /** The headroom each write adds on top of its gas estimate, in basis points. */
    readonly gasDriftMarginBps: number
    readonly target: EthereumOutpostTarget
  }

  /** What every Solana write of one operator resolves once. */
  interface SolanaWriteContext {
    readonly operator: FundedOperator
    /** The operator's ED key, through the custody facade. */
    readonly user: SolanaSigner
    readonly native: NativeAllocation
    /** The outpost's launch state, selecting `synd`'s account form. */
    readonly wireState: WireState
    readonly target: SolanaOutpostTarget
  }

  // ── key adoption ──────────────────────────────────────────────────────────

  /**
   * Adopt every batch operator's pre-created OUTPOST keys — solana ED and
   * ethereum EM, the two that sign a funding write — through the SAME seam the
   * bootstrap uses (`KeySteps.adoptOrCreateSignatureProviderKey`), under the
   * ADOPT-ONLY policy: a key the custody store does not hold fails naming its
   * id, and is never created — funding a key this run minted would bind real
   * value to an identity no launch adopts. The WIRE K1 is not adopted: nothing
   * here signs with it. Refuses a KEY / KIOD provider (no custody store to
   * adopt from) and a label that is not a bootstrap batch operator's.
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
  ): Promise<FundedOperator[]> {
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
      const [solana, ethereum] = await Promise.all([
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
      return { label, ethereum, solana }
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

  /**
   * The native balance a leg requires: `stake + reserve` while its plan still
   * deposits native value, the reserve alone once it does not — skipped for an
   * existing position, or resumed past a deposit that already landed.
   *
   * @param plan - The leg's plan.
   * @param stake - The stake, in the chain's base units.
   * @param reserve - The reserve, in the chain's base units.
   * @returns The required balance.
   */
  export function requiredNative(
    plan: LegPlan,
    stake: bigint,
    reserve: bigint
  ): bigint {
    return plan.writes.some(action => NativeDepositActions.has(action))
      ? stake + reserve
      : reserve
  }

  /**
   * A gas estimate with `gasDriftMarginBps` of headroom on top, rounded UP:
   * `ceil(estimate × (10_000 + bps) / 10_000)` — wire-ethereum's funding crank
   * arithmetic, so a margin of 0 is exactly the estimate.
   *
   * @param estimate - The gas estimate.
   * @param gasDriftMarginBps - The headroom, in basis points (a non-negative integer).
   * @returns The gas limit to send with.
   */
  export function addGasMargin(estimate: bigint, gasDriftMarginBps: number): bigint {
    const denominator = WireSyndicationTool.BasisPoints
    return (
      (estimate * (denominator + BigInt(gasDriftMarginBps)) + denominator - 1n) /
      denominator
    )
  }

  /** The Solana wallet of an operator's ED pair, read off its stored public key (no secret). */
  function solanaWallet(operator: FundedOperator): PublicKey {
    return new PublicKey(solanaNativePublicKey(operator.solana))
  }

  /** An operator whose both outpost keys were adopted — the precondition of every check and write. */
  function assertOutpostKeys(operator: FundedOperator): FundedOperator {
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

  /**
   * The post-launch Ethereum surface the writes need: the pool recorded,
   * unpaused and above the stake, and the document's `ethereum.asOfBlock` —
   * the marker the operators' `Syndicated` history counts from.
   */
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
      target.asOfBlock != null,
      "BatchOperatorFundingTool: the Ethereum outpost is post-launch and the external outpost config carries no ethereum.asOfBlock — post-launch idempotency counts from the document's asOf marker; add ethereum.asOfBlock (the finalized block the document was generated at)"
    )
    log.info(
      `[fund-batch-operators] Ethereum post-launch positions count from ethereum.asOfBlock ${target.asOfBlock} — the document's marker`
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

  /**
   * The PostLaunch Solana marker the position reads count from: the
   * document's `solana.asOfSlot`.
   */
  function assertPostLaunchSolana(target: SolanaOutpostTarget): void {
    Assert.ok(
      target.asOfSlot != null,
      `BatchOperatorFundingTool: the Solana outpost is ${WireState.postLaunch} and the external outpost config carries no solana.asOfSlot — post-launch idempotency counts from the document's asOf marker; add solana.asOfSlot (the finalized slot the document was generated at)`
    )
    log.info(
      `[fund-batch-operators] Solana ${WireState.postLaunch} positions count from solana.asOfSlot ${target.asOfSlot} — the document's marker`
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

  /** A leg an existing position skips: nothing to write. */
  function skippedLeg(position: bigint): LegPlan {
    return { position, writes: [] }
  }

  /**
   * `action` when `needed`, else nothing — the resumption logged, naming what
   * already covers the stake, so a resumed leg's dropped writes are on the
   * record (a skipped write produces no receipt).
   */
  function stillNeeded(
    label: string,
    action: FundingAction,
    needed: boolean,
    covering: string
  ): FundingAction[] {
    if (needed) return [action]
    log.info(
      `[fund-batch-operators] ${label} ${action} skipped — ${covering} already covers the stake`
    )
    return []
  }

  /**
   * The liq the operator already holds staked on a post-launch Ethereum
   * outpost: its `Syndicated` total on the pool from the document's
   * `asOfBlock` on (the preflight has required the marker), or — while the
   * address book still records the pre-launch Depositor — the shares it
   * staked pre-launch and carries past D-Day.
   */
  async function readPostLaunchEthereumPosition(
    target: EthereumOutpostTarget,
    address: string
  ): Promise<bigint> {
    const syndicated = await EthereumSyndicationTool.readSyndicatedPosition(
      target,
      address,
      target.asOfBlock
    )
    if (syndicated > 0n) return syndicated
    return EthereumPreLaunchStakingTool.hasStakingContract(
      target.outpostAddresses
    )
      ? EthereumPreLaunchStakingTool.readStakedShares(target, address)
      : 0n
  }

  /**
   * The Ethereum leg's plan, read from the chain. Pre-launch: skipped when
   * the operator holds Depositor shares, else ONE `depositAndStake`.
   * Post-launch: skipped when it holds a position
   * ({@link readPostLaunchEthereumPosition}), else `deposit` unless its
   * liqETH already covers the stake, `approve` unless the pool's allowance
   * already does, and `syndicate`.
   */
  async function planEthereumLeg(
    operator: FundedOperator,
    native: NativeAllocation,
    phase: EthereumLaunchPhase,
    target: EthereumOutpostTarget
  ): Promise<LegPlan> {
    const { label } = operator,
      { address } = operator.ethereum
    return match(phase)
      .with(EthereumLaunchPhase.preLaunch, async (): Promise<LegPlan> => {
        const shares = await EthereumPreLaunchStakingTool.readStakedShares(
          target,
          address
        )
        return shares > 0n
          ? skippedLeg(shares)
          : { position: 0n, writes: [FundingAction.depositAndStake] }
      })
      .with(EthereumLaunchPhase.postLaunch, async (): Promise<LegPlan> => {
        const position = await readPostLaunchEthereumPosition(target, address)
        if (position > 0n) return skippedLeg(position)
        const poolAddress = await EthereumSyndicationTool.loadSyndicationPool(
            target,
            target.provider
          ).getAddress(),
          held = await EthereumSyndicationTool.readLiqEthBalance(target, address),
          allowance = await EthereumSyndicationTool.readLiqEthAllowance(
            target,
            address,
            poolAddress
          )
        return {
          position: 0n,
          writes: [
            ...stillNeeded(
              label,
              FundingAction.deposit,
              held < native.stakeWei,
              `liqETH ${held} wei`
            ),
            ...stillNeeded(
              label,
              FundingAction.approve,
              allowance < native.stakeWei,
              `the pool's allowance ${allowance} wei`
            ),
            FundingAction.syndicate
          ]
        }
      })
      .exhaustive()
  }

  /**
   * The Solana leg's plan, read from the chain: skipped when the operator
   * holds a syndicated position ({@link SolanaLiqSyndicationTool.readSyndicatedPosition}
   * — a PreLaunch `OutpostAccount` stake, or PostLaunch `synd`s from the
   * document's `asOfSlot` on), else `sol_to_liqsol` unless its liqSOL already
   * covers the stake, and `synd`.
   */
  async function planSolanaLeg(
    operator: FundedOperator,
    native: NativeAllocation,
    target: SolanaOutpostTarget
  ): Promise<LegPlan> {
    const { label } = operator,
      wallet = solanaWallet(operator),
      position = await SolanaLiqSyndicationTool.readSyndicatedPosition(
        target,
        wallet,
        target.asOfSlot
      )
    if (position > 0n) return skippedLeg(position)
    const held = await SolanaLiqSyndicationTool.readLiqsolBalanceOf(
      target,
      wallet
    )
    return {
      position: 0n,
      writes: [
        ...stillNeeded(
          label,
          FundingAction.solToLiqsol,
          held < native.stakeLamports,
          `liqSOL ${held}`
        ),
        FundingAction.synd
      ]
    }
  }

  /** The operator holds what each leg's plan requires on its outpost ({@link requiredNative}). */
  async function assertBalances(
    plan: OperatorPlan,
    native: NativeAllocation,
    targets: Targets
  ): Promise<void> {
    const { operator } = plan,
      { label, ethereum, solana } = operator,
      ethereumBalance = await targets.ethereum.provider.getBalance(
        ethereum.address
      ),
      ethereumRequired = requiredNative(
        plan.ethereum,
        native.stakeWei,
        native.reserveWei
      )
    Assert.ok(
      ethereumBalance >= ethereumRequired,
      `BatchOperatorFundingTool: ${label}'s Ethereum balance ${ethereumBalance} wei at ${ethereum.address} is below the required ${ethereumRequired} wei`
    )
    const wallet = solanaWallet(operator),
      lamports = BigInt(await targets.solana.connection.getBalance(wallet)),
      solanaRequired = requiredNative(
        plan.solana,
        native.stakeLamports,
        native.reserveLamports
      )
    Assert.ok(
      lamports >= solanaRequired,
      `BatchOperatorFundingTool: ${label}'s Solana balance ${lamports} lamports at ${wallet.toBase58()} is below the required ${solanaRequired} lamports`
    )
    log.info(
      `[fund-batch-operators] ${label} holds ${ethereumBalance} wei (needs ${ethereumRequired}) and ${lamports} lamports (needs ${solanaRequired}) — ${solanaNativePublicKey(solana)}`
    )
  }

  /** One operator's plan: both legs read from the chain, then its balances asserted against them. */
  async function planOperator(
    operator: FundedOperator,
    native: NativeAllocation,
    ethereumPhase: EthereumLaunchPhase,
    targets: Targets
  ): Promise<OperatorPlan> {
    assertOutpostKeys(operator)
    const plan: OperatorPlan = {
      operator,
      ethereum: await planEthereumLeg(
        operator,
        native,
        ethereumPhase,
        targets.ethereum
      ),
      solana: await planSolanaLeg(operator, native, targets.solana)
    }
    await assertBalances(plan, native, targets)
    return plan
  }

  /**
   * Establish every precondition of the run BEFORE the first write — the
   * allocation's gas margin, the chain id behind the Ethereum endpoint, the
   * LIQSOL mint, both launch states (and, for a post-launch one, the
   * document's as-of marker its positions count from), both per-transfer
   * maxima, and, per operator, its position and plan on each outpost
   * ({@link LegPlan}) and the balance that plan requires — so a refusal (the
   * common failure class) never leaves one operator funded and the next not.
   * Reads only.
   *
   * @param operators - The adopted identities.
   * @param allocation - The stake + reserve, in depot units, and the Ethereum gas margin.
   * @param targets - The two outposts.
   * @returns What the writes run against.
   * @throws On the first unmet precondition, naming it.
   */
  export async function assertFundable(
    operators: readonly FundedOperator[],
    allocation: Allocation,
    targets: Targets
  ): Promise<FundingPreflight> {
    Assert.ok(operators.length > 0, "BatchOperatorFundingTool: no operator to fund")
    const native = nativeAllocation(allocation),
      { gasDriftMarginBps } = allocation
    Assert.ok(
      native.stakeWei > 0n && native.stakeLamports > 0n,
      "BatchOperatorFundingTool: every stake must be positive"
    )
    Assert.ok(
      Number.isInteger(gasDriftMarginBps) && gasDriftMarginBps >= 0,
      `BatchOperatorFundingTool: gasDriftMarginBps ${gasDriftMarginBps} must be a non-negative integer of basis points`
    )
    await EthereumOutpostTarget.assertChainId(targets.ethereum)
    assertLiqsolMint(targets.solana)
    const ethereumPhase = await resolveEthereumLaunchPhase(targets.ethereum)
    if (ethereumPhase === EthereumLaunchPhase.postLaunch) {
      await assertPostLaunchEthereum(targets.ethereum, native)
    }
    const wireState = await resolveWireState(targets.solana)
    if (wireState === WireState.postLaunch) {
      assertPostLaunchSolana(targets.solana)
    }
    await assertSolanaSyndicationMaximum(targets.solana, native)
    const plans = await mapSeries(operators, operator =>
      planOperator(operator, native, ethereumPhase, targets)
    )
    return { native, gasDriftMarginBps, ethereumPhase, wireState, plans }
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /**
   * Send `request` from the context's signer with an explicitly drawn nonce and
   * wait for it to mine — the ONE Ethereum submission path of this tool. The
   * call is estimated first and sent with its `gasLimit` set to the estimate
   * plus the context's `gasDriftMarginBps` ({@link addGasMargin}). A failed
   * estimate or send drops the signer's cached nonce so the next draw re-seeds
   * from the chain.
   *
   * @param context - The operator's write context (signer + gas margin).
   * @param request - The call to send.
   * @param label - What is being sent, for the log and failure messages.
   * @returns The mined transaction's hash.
   * @throws If the estimate fails or the transaction reverts.
   */
  async function sendEthereum(
    context: EthereumWriteContext,
    request: ethers.TransactionRequest,
    label: string
  ): Promise<string> {
    const { signer, gasDriftMarginBps } = context,
      nonce = await resolveLatestNonce(signer)
    try {
      const estimate = await signer.estimateGas({ ...request, nonce }),
        gasLimit = addGasMargin(estimate, gasDriftMarginBps)
      log.debug(
        `${label}: gas estimate ${estimate}, gasLimit ${gasLimit} (+${gasDriftMarginBps} bps)`
      )
      const response = await signer.sendTransaction({ ...request, nonce, gasLimit }),
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

  /** What a write is, for its submission + failure messages. */
  function writeLabel(operator: FundedOperator, action: FundingAction): string {
    return `fund-batch-operators ${operator.label} ${action}`
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

  /** One skip row, logged like a receipt. */
  function skip(
    label: string,
    chain: Constants.OutpostChainCodename,
    reason: SkipReason,
    amount: bigint
  ): Skip {
    log.info(
      `[fund-batch-operators] ${label} ${chain} skipped — ${reason} ${amount}`
    )
    return { label, chain, reason, amount }
  }

  /** Ethereum pre-launch: ONE `Depositor.depositAndStake{value: stake}`. */
  async function sendDepositAndStake(
    context: EthereumWriteContext
  ): Promise<Receipt> {
    const { operator, signer, native, target } = context,
      staking = EthereumPreLaunchStakingTool.loadStakingContract(
        target,
        signer
      ),
      hash = await sendEthereum(
        context,
        EthereumPreLaunchStakingTool.depositAndStakeRequest(
          staking,
          native.stakeWei
        ),
        writeLabel(operator, FundingAction.depositAndStake)
      )
    return receipt(
      operator.label,
      Constants.ETHEREUM_CHAIN_CODENAME,
      FundingAction.depositAndStake,
      hash,
      native.stakeWei
    )
  }

  /** Ethereum post-launch: ONE `DepositManager.deposit{value: stake}` (ETH → liqETH). */
  async function sendDepositLiqEth(
    context: EthereumWriteContext
  ): Promise<Receipt> {
    const { operator, signer, native, target } = context,
      depositManager = EthereumSyndicationTool.loadDepositManager(target, signer),
      hash = await sendEthereum(
        context,
        EthereumSyndicationTool.depositLiqEthRequest(
          depositManager,
          native.stakeWei
        ),
        writeLabel(operator, FundingAction.deposit)
      )
    return receipt(
      operator.label,
      Constants.ETHEREUM_CHAIN_CODENAME,
      FundingAction.deposit,
      hash,
      native.stakeWei
    )
  }

  /** Ethereum post-launch: ONE liqETH `approve(SyndicationPool, stake)` — exactly the stake, never the balance. */
  async function sendApproveLiqEth(
    context: EthereumWriteContext
  ): Promise<Receipt> {
    const { operator, signer, native, target } = context,
      liqEth = EthereumSyndicationTool.loadLiqEthToken(target, signer),
      poolAddress = await EthereumSyndicationTool.loadSyndicationPool(
        target,
        signer
      ).getAddress(),
      hash = await sendEthereum(
        context,
        EthereumSyndicationTool.approveLiqEthRequest(
          liqEth,
          poolAddress,
          native.stakeWei
        ),
        writeLabel(operator, FundingAction.approve)
      )
    return receipt(
      operator.label,
      Constants.ETHEREUM_CHAIN_CODENAME,
      FundingAction.approve,
      hash,
      native.stakeWei
    )
  }

  /**
   * Ethereum post-launch: ONE `SyndicationPool.syndicate(stake,
   * compressedPubkey)` — exactly the stake, never the balance — once the
   * operator's liqETH is confirmed to cover it (the deposit landed, or was
   * already held).
   */
  async function sendSyndicate(context: EthereumWriteContext): Promise<Receipt> {
    const { operator, signer, native, target } = context,
      { label } = operator,
      held = await EthereumSyndicationTool.readLiqEthBalance(
        target,
        operator.ethereum.address
      )
    Assert.ok(
      held >= native.stakeWei,
      `BatchOperatorFundingTool: ${label} holds ${held} liqETH wei — below the stake ${native.stakeWei} wei to syndicate`
    )
    const hash = await sendEthereum(
      context,
      EthereumSyndicationTool.syndicateRequest(
        EthereumSyndicationTool.loadSyndicationPool(target, signer),
        native.stakeWei,
        ethers.hexlify(ethereumCompressedPubkey(operator.ethereum))
      ),
      writeLabel(operator, FundingAction.syndicate)
    )
    return receipt(
      label,
      Constants.ETHEREUM_CHAIN_CODENAME,
      FundingAction.syndicate,
      hash,
      native.stakeWei
    )
  }

  /** ONE Ethereum write of `action` — the dispatch of a leg's plan. */
  function sendEthereumWrite(
    context: EthereumWriteContext,
    action: FundingAction
  ): Promise<Receipt> {
    return match(action)
      .with(FundingAction.depositAndStake, () => sendDepositAndStake(context))
      .with(FundingAction.deposit, () => sendDepositLiqEth(context))
      .with(FundingAction.approve, () => sendApproveLiqEth(context))
      .with(FundingAction.syndicate, () => sendSyndicate(context))
      .otherwise(() => {
        throw new Error(
          `BatchOperatorFundingTool: ${action} is not an Ethereum write`
        )
      })
  }

  /**
   * Solana: ONE `sol_to_liqsol(stake)` — standing off the runtime's
   * epoch-rewards window exactly as the deposit Step does.
   */
  async function sendDepositForLiqsol(
    context: SolanaWriteContext
  ): Promise<Receipt> {
    const { operator, user, native, target } = context,
      { label } = operator,
      { stakeLamports } = native,
      ephemeralStakeSeed = SolanaLiqSyndicationTool.nextEphemeralStakeSeed(label),
      depositLabel = writeLabel(operator, FundingAction.solToLiqsol)
    let signature: string = null
    await SolanaLiqSyndicationTool.waitForEpochRewardsIdle(target, depositLabel)
    await SolanaLiqSyndicationTool.submitWithEpochRewardsRetry(
      target,
      depositLabel,
      async () => {
        signature = await SolanaLiqSyndicationTool.submit(
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
    return receipt(
      label,
      Constants.SOLANA_CHAIN_CODENAME,
      FundingAction.solToLiqsol,
      signature,
      stakeLamports
    )
  }

  /**
   * Solana: ONE `synd(stake)` in the launch state's account form — exactly
   * the stake, never the balance — once the operator's liqSOL is confirmed to
   * cover it (the deposit landed, or was already held).
   */
  async function sendSynd(context: SolanaWriteContext): Promise<Receipt> {
    const { operator, user, native, wireState, target } = context,
      { label } = operator,
      { stakeLamports } = native,
      held = await SolanaLiqSyndicationTool.readLiqsolBalanceOf(
        target,
        user.publicKey
      )
    Assert.ok(
      held >= stakeLamports,
      `BatchOperatorFundingTool: ${label} holds ${held} liqSOL — below the stake ${stakeLamports} to syndicate`
    )
    const signature = await SolanaLiqSyndicationTool.submit(
      target,
      await SolanaLiqSyndicationTool.syndTransaction(
        target,
        user,
        stakeLamports,
        wireState
      ),
      user,
      writeLabel(operator, FundingAction.synd)
    )
    return receipt(
      label,
      Constants.SOLANA_CHAIN_CODENAME,
      FundingAction.synd,
      signature,
      stakeLamports
    )
  }

  /** ONE Solana write of `action` — the dispatch of a leg's plan. */
  function sendSolanaWrite(
    context: SolanaWriteContext,
    action: FundingAction
  ): Promise<Receipt> {
    return match(action)
      .with(FundingAction.solToLiqsol, () => sendDepositForLiqsol(context))
      .with(FundingAction.synd, () => sendSynd(context))
      .otherwise(() => {
        throw new Error(`BatchOperatorFundingTool: ${action} is not a Solana write`)
      })
  }

  /**
   * Fund one operator on Ethereum per its leg's plan: skipped outright for an
   * existing position (the skip returned), else the planned writes in order,
   * each signed by the operator's EM key through the custody facade
   * (`keyPairUtils.ethereumSigner`) and its receipt appended as it lands.
   */
  async function fundEthereum(
    operator: FundedOperator,
    preflight: FundingPreflight,
    plan: LegPlan,
    target: EthereumOutpostTarget,
    receipts: Receipt[]
  ): Promise<Skip> {
    const chain = Constants.ETHEREUM_CHAIN_CODENAME
    if (plan.writes.length === 0) {
      return skip(operator.label, chain, SkipReason.existingPosition, plan.position)
    }
    const context: EthereumWriteContext = {
      operator,
      signer: await ethereumSigner(operator.ethereum, target.provider),
      native: preflight.native,
      gasDriftMarginBps: preflight.gasDriftMarginBps,
      target
    }
    await eachSeries(plan.writes, async action => {
      receipts.push(await sendEthereumWrite(context, action))
    })
    return null
  }

  /**
   * Fund one operator on Solana per its leg's plan: skipped outright for an
   * existing position (the skip returned), else the planned writes in order,
   * each signed by the operator's ED key through the custody facade
   * (`keyPairUtils.solanaSigner`, so a KMS-custodied key signs remotely) and
   * its receipt appended as it lands.
   */
  async function fundSolana(
    operator: FundedOperator,
    preflight: FundingPreflight,
    plan: LegPlan,
    target: SolanaOutpostTarget,
    receipts: Receipt[]
  ): Promise<Skip> {
    const chain = Constants.SOLANA_CHAIN_CODENAME
    if (plan.writes.length === 0) {
      return skip(operator.label, chain, SkipReason.existingPosition, plan.position)
    }
    const context: SolanaWriteContext = {
      operator,
      user: await solanaSigner(operator.solana),
      native: preflight.native,
      wireState: preflight.wireState,
      target
    }
    await eachSeries(plan.writes, async action => {
      receipts.push(await sendSolanaWrite(context, action))
    })
    return null
  }

  /** Run one leg over `receipts`, recording its skip; a rejection becomes the run's {@link Failure}. */
  async function fundLeg(
    operator: FundedOperator,
    leg: FundingLeg,
    receipts: Receipt[],
    skips: Skip[]
  ): Promise<Failure> {
    return leg.fund(receipts).then(
      legSkip => {
        if (legSkip != null) skips.push(legSkip)
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

  /** Fund one operator per its plan, Ethereum then Solana, stopping at the first failed leg. */
  async function fundOperator(
    plan: OperatorPlan,
    preflight: FundingPreflight,
    targets: Targets,
    receipts: Receipt[],
    skips: Skip[]
  ): Promise<Failure> {
    const { operator } = plan,
      legs: FundingLeg[] = [
        {
          chain: Constants.ETHEREUM_CHAIN_CODENAME,
          fund: receipts =>
            fundEthereum(operator, preflight, plan.ethereum, targets.ethereum, receipts)
        },
        {
          chain: Constants.SOLANA_CHAIN_CODENAME,
          fund: receipts =>
            fundSolana(operator, preflight, plan.solana, targets.solana, receipts)
        }
      ]
    return legs.reduce<Promise<Failure>>(
      async (previous, leg) =>
        (await previous) ?? fundLeg(operator, leg, receipts, skips),
      Promise.resolve(null)
    )
  }

  /**
   * Fund every operator on both outposts: {@link assertFundable} first (a
   * refusal there writes nothing; its plans decide every skip and
   * resumption), then operator by operator, Ethereum then Solana, one
   * transaction per write, each awaited for its receipt and recorded as it
   * lands. The first write failure stops the run; every receipt and skip
   * that preceded it — the failed leg's own landed writes included — is
   * returned either way.
   *
   * @param operators - The adopted identities ({@link adoptOperators}).
   * @param allocation - The stake + reserve, in depot units, and the Ethereum gas margin.
   * @param targets - The two outposts.
   * @returns Every landed receipt and skipped leg, plus the failure that stopped the run if one did.
   * @throws If a precondition is unmet — before any write.
   */
  export async function fund(
    operators: readonly FundedOperator[],
    allocation: Allocation,
    targets: Targets
  ): Promise<Outcome> {
    const preflight = await assertFundable(operators, allocation, targets),
      receipts: Receipt[] = [],
      skips: Skip[] = [],
      failure = await preflight.plans.reduce<Promise<Failure>>(
        async (previous, plan) =>
          (await previous) ??
          fundOperator(plan, preflight, targets, receipts, skips),
        Promise.resolve(null)
      )
    return failure == null
      ? { receipts, skips }
      : { receipts, skips, failure }
  }

  // ── output ────────────────────────────────────────────────────────────────

  /** The JSON replacer that renders a bigint amount as its decimal string. */
  function listingReplacer(_key: string, value: unknown): unknown {
    return match(value)
      .with(P.bigint, amount => amount.toString())
      .otherwise(identity)
  }

  /**
   * The listing as the JSON document `fund-batch-operators` prints on stdout
   * — `{ receipts, skips }` and nothing else (an {@link Outcome}'s failure
   * goes to the log), amounts rendered as decimal strings (JSON has no
   * bigint).
   *
   * @param listing - The landed receipts and skipped legs.
   * @returns The JSON text.
   */
  export function toListingJson(listing: Listing): string {
    const { receipts, skips } = listing
    return JSON.stringify({ receipts, skips }, listingReplacer, ListingIndent)
  }
}
