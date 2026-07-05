import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"
import { PublicKey } from "@solana/web3.js"
import {
  contractView,
  EthereumCollateralTool,
  SolanaOutpostBootstrapper,
  type ClusterBuildContext
} from "@wireio/cluster-tool"
import { SwapPrivateReservesScenarioConstants as Constants } from "./SwapPrivateReservesScenarioConstants.js"

/**
 * Deploy-artifact resolution shared by the flow's step runners and verify
 * steps — pure VALUE helpers (reads), never steps themselves: the
 * `ReserveManager` contract binding (address from `outpost-addrs.json`, ABI
 * from the hardhat artifact) and the USDCSOL mock mint persisted by the
 * Solana outpost bootstrap.
 */
export namespace SwapPrivateReservesScenarioArtifacts {
  /** The `ReserveManager` entry name in `outpost-addrs.json` / the artifact tree. */
  export const ReserveManagerContractName = "ReserveManager"

  /**
   * Structural surface of the `ReserveManager` members this flow binds beyond
   * the harness's swap surface: the payable native `create_reserve` write and
   * the `getReserve` local-record read. (Following the harness's
   * `OperatorRegistryContract` precedent — typechain types live in
   * `wire-ethereum` and are not consumable here.)
   */
  export interface ReserveManagerPrivateReserveContract extends ethers.BaseContract {
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

  /**
   * Bind the deployed `ReserveManager` to `signer` — address from
   * the cluster deployments dir (`ClusterConfig.ethereumDeploymentsPath`), ABI from the
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
    const address = EthereumCollateralTool.loadOutpostAddresses(ctx.config.ethereumDeploymentsPath)[
      ReserveManagerContractName
    ]
    Assert.ok(
      address != null && /^0x[0-9a-fA-F]{40}$/.test(address),
      `SwapPrivateReservesScenario: ${ReserveManagerContractName} not in outpost-addrs.json (got ${address})`
    )
    const abi = EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      ReserveManagerContractName
    )
    return contractView<View>(address, abi, signer)
  }

  /**
   * The USDCSOL mock mint persisted by the Solana outpost bootstrap
   * (`<dataPath>/sol-mock-mints.json`, rows of
   * {@link SolanaOutpostBootstrapper.PersistedSplMint}).
   *
   * @param ctx - The build context (carries `config.dataPath`).
   * @returns The mint pubkey.
   * @throws When the manifest or the USDCSOL entry is missing.
   */
  export function loadUsdcSolMint<C extends ClusterBuildContext>(ctx: C): PublicKey {
    const mintsFile = Path.join(ctx.config.dataPath, Constants.SolanaMockMintsFilename)
    Assert.ok(
      Fs.existsSync(mintsFile),
      `SwapPrivateReservesScenario: mock SPL mints not found at ${mintsFile}`
    )
    const mints = JSON.parse(
      Fs.readFileSync(mintsFile, "utf8")
    ) as SolanaOutpostBootstrapper.PersistedSplMint[]
    const usdcSolEntry = mints.find(
      entry => entry.code === Constants.Reserves.Solana.TokenCode
    )
    Assert.ok(
      usdcSolEntry != null,
      "SwapPrivateReservesScenario: bootstrap did not persist the USDCSOL SPL mint"
    )
    return new PublicKey(usdcSolEntry.mint)
  }
}
