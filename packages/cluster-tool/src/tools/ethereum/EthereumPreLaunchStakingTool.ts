/**
 * EthereumPreLaunchStakingTool — the PRE-LAUNCH staking surface of a deployed
 * Ethereum outpost: the v3 staking proxy mainnet's address book records under
 * the key {@link EthereumPreLaunchStakingTool.StakingContractName}
 * (`wire-ethereum/contracts/outpost/v3/Depositor.sol`, artifact
 * `DepositorV3Deployed`, pinned to the live bytecode). Its payable
 * `depositAndStake()` is what a pre-funded launch stakes a batch operator's
 * ETH through — ETH → liqETH via the DepositManager, then staked under
 * `msg.sender`, the position the launch snapshot's `stakers[]` carries — and
 * its `dDay` / `isRefundActive` / `paused` flags are what decide whether the
 * outpost is still pre-launch at all.
 *
 * Value helpers (the loader, the reads) plus the ONE pure request builder the
 * caller encodes its write through; the submission lives with the caller
 * (`BatchOperatorFundingTool`). Addressed by an {@link EthereumOutpostTarget}
 * only: no cluster bootstrap ever stakes through this surface.
 */

import { ethers } from "ethers"
import type { ExternalOutpostConfigEthereum } from "@wireio/cluster-tool-shared"

import { loadOutpostContract } from "../../utils/ethereumUtils.js"
import type { EthereumOutpostTarget } from "./EthereumOutpostTarget.js"

export namespace EthereumPreLaunchStakingTool {
  /**
   * The address-book key of the deployed pre-launch staking proxy — the name
   * `outpost-addrs-<network>.json` records it under (the SAME proxy also
   * appears under its per-era aliases). Absent from a book whose outpost was
   * deployed post-launch, which is how the funding tool tells the two apart.
   */
  export const StakingContractName = "Depositor"
  /** Artifact dir segments of the staking contract under `artifacts/contracts`. */
  export const StakingArtifactSubpath = ["outpost", "v3"] as const
  /** The compiled contract name inside the snapshot's artifact (`<Name>.sol/<Name>Deployed.json`). */
  export const StakingArtifactContractName = "DepositorV3Deployed"

  /** The staking contract function the tool encodes, by ABI name. */
  export enum StakingFunction {
    depositAndStake = "depositAndStake"
  }

  /** The staking-contract reads this tool makes. */
  export interface PreLaunchStakingView {
    /** Whether go-live has started (`setDDay`): every stake path is closed. */
    dDay(): Promise<boolean>
    /** Whether the refund window is open (`setRefundActive`): every stake path is closed. */
    isRefundActive(): Promise<boolean>
    /** The OpenZeppelin pause flag. */
    paused(): Promise<boolean>
    /** The staker's share balance — non-zero once it has staked. */
    sharesOf(account: string): Promise<bigint>
  }

  /** The three flags that gate `depositAndStake`, read together. */
  export interface LaunchGate {
    /** `dDay()`. */
    readonly dDay: boolean
    /** `isRefundActive()`. */
    readonly refundActive: boolean
    /** `paused()`. */
    readonly paused: boolean
  }

  /**
   * Whether an outpost address book records the pre-launch staking proxy —
   * the sign the outpost was deployed with the pre-launch set.
   *
   * @param outpostAddresses - The outpost deploy's address book.
   * @returns `true` when the staking proxy is recorded.
   */
  export function hasStakingContract(
    outpostAddresses: ExternalOutpostConfigEthereum["outpostAddresses"]
  ): boolean {
    return outpostAddresses[StakingContractName] != null
  }

  /**
   * The deployed staking contract, from the target's outpost address book and
   * the snapshot artifact.
   *
   * @param target - The outpost target.
   * @param runner - The signer (writes) or provider (reads) to bind.
   * @returns The staking contract.
   * @throws If the book records no staking proxy, or the artifact is absent.
   */
  export function loadStakingContract(
    target: EthereumOutpostTarget,
    runner: ethers.ContractRunner
  ): PreLaunchStakingView & ethers.BaseContract {
    return loadOutpostContract<PreLaunchStakingView>(
      target.ethereumPath,
      target.outpostAddresses,
      StakingContractName,
      [...StakingArtifactSubpath],
      runner,
      StakingContractName,
      StakingArtifactContractName
    )
  }

  /**
   * `depositAndStake()` with `amountWei` attached — the ONE encoding of the
   * pre-launch stake, pure so a test checks it without a chain.
   *
   * @param staking - The bound staking contract.
   * @param amountWei - Wei to deposit and stake.
   * @returns The transaction request.
   */
  export function depositAndStakeRequest(
    staking: ethers.BaseContract,
    amountWei: bigint
  ): ethers.TransactionRequest {
    return {
      to: staking.target,
      data: staking.interface.encodeFunctionData(
        StakingFunction.depositAndStake,
        []
      ),
      value: amountWei
    }
  }

  /**
   * The three gate flags of the staking contract. A READ.
   *
   * @param target - The outpost target.
   * @returns The flags.
   */
  export async function readLaunchGate(
    target: EthereumOutpostTarget
  ): Promise<LaunchGate> {
    const staking = loadStakingContract(target, target.provider)
    return {
      dDay: await staking.dDay(),
      refundActive: await staking.isRefundActive(),
      paused: await staking.paused()
    }
  }

  /**
   * `account`'s staked shares on the staking contract — non-zero once it has
   * staked. A READ.
   *
   * @param target - The outpost target.
   * @param account - The staker's address.
   * @returns The share balance.
   */
  export async function readStakedShares(
    target: EthereumOutpostTarget,
    account: string
  ): Promise<bigint> {
    return loadStakingContract(target, target.provider).sharesOf(account)
  }
}
