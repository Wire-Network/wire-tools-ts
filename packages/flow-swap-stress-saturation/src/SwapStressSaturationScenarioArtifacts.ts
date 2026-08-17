import Assert from "node:assert"
import { ethers } from "ethers"
import { PublicKey } from "@solana/web3.js"
import {
  contractView,
  EthereumCollateralTool,
  SolanaFundingTool,
  type ClusterBuildContext,
  type ReserveManagerRequestSwapContract,
  ClusterConfigProvider
} from "@wireio/cluster-tool"
import { SwapStressSaturationScenarioConstants as Constants } from "./SwapStressSaturationScenarioConstants.js"

/**
 * Deploy-artifact resolution shared by the flow's step runners and verify
 * steps — pure VALUE helpers (reads), never steps themselves: the
 * `ReserveManager` contract binding (address from `outpost-addrs.json`, ABI
 * from the hardhat artifact) and the USDCSOL mock mint persisted by the
 * Solana outpost bootstrap.
 */
export namespace SwapStressSaturationScenarioArtifacts {
  /** The `ReserveManager` entry name in `outpost-addrs.json` / the artifact tree. */
  export const ReserveManagerContractName = "ReserveManager"

  /**
   * The native-value leg of the payable `create_reserve` overrides — the
   * `msg.value` the reserve is seeded with, intersected over
   * `ethers.Overrides` at the call signature.
   */
  export interface ReserveManagerNativeValueOverride {
    value: bigint
  }

  /**
   * The `ReserveManager.getReserve` local-record read result — only the
   * `status` word this flow asserts on.
   */
  export interface ReserveManagerReserveRecord {
    status: bigint
  }

  /**
   * Structural surface of the `ReserveManager` members this flow binds beyond
   * the harness's swap surface: the payable native `create_reserve` write and
   * the `getReserve` local-record read — plus the inherited `requestSwap`
   * ({@link ReserveManagerRequestSwapContract}) the ramp campaign's phase-1
   * bursts submit. (Following the harness's `OperatorRegistryContract`
   * precedent — typechain types live in `wire-ethereum` and are not
   * consumable here.)
   */
  export interface ReserveManagerPrivateReserveContract
    extends ReserveManagerRequestSwapContract {
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
      overrides: ethers.Overrides & ReserveManagerNativeValueOverride
    ) => Promise<ethers.ContractTransactionResponse>
    getReserve: (
      tokenCode: bigint,
      reserveCode: bigint
    ) => Promise<ReserveManagerReserveRecord>
  }

  /**
   * Bind the deployed `ReserveManager` to `signer` — address from
   * the cluster deployments dir (`ClusterConfigProvider.ethereumDeploymentsPath`), ABI from the
   * hardhat artifact (both via the harness's exported artifact readers).
   *
   * @param ctx - The build context (carries `config.ethereumPath`).
   * @param signer - The wallet the writes are signed by.
   * @returns The signer-connected contract.
   */
  export function loadReserveManager<
    View extends object,
    C extends ClusterBuildContext = ClusterBuildContext
  >(ctx: C, signer: ethers.Signer): View & ethers.BaseContract {
    const address = EthereumCollateralTool.loadOutpostAddresses(
      ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
    )[ReserveManagerContractName]
    Assert.ok(
      address != null && /^0x[0-9a-fA-F]{40}$/.test(address),
      `SwapStressSaturationScenario: ${ReserveManagerContractName} not in outpost-addrs.json (got ${address})`
    )
    const abi = EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      ReserveManagerContractName
    )
    return contractView<View>(address, abi, signer)
  }

  /**
   * The USDCSOL mock mint persisted by the Solana outpost bootstrap.
   *
   * Delegates to the harness accessor, which owns the manifest filename and
   * the not-found diagnostics (it lists the persisted codes on a miss).
   *
   * @param ctx - The build context (carries `config.dataPath`).
   * @returns The mint pubkey.
   * @throws When the manifest or the USDCSOL entry is missing.
   */
  export function loadUsdcSolMint<C extends ClusterBuildContext>(
    ctx: C
  ): PublicKey {
    return new PublicKey(
      SolanaFundingTool.solMintAddress(
        ctx.config.dataPath,
        BigInt(Constants.Reserves.Solana.TokenCode)
      )
    )
  }
}
