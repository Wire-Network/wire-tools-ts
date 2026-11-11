import { ethers } from "ethers"
import { EthereumWallet } from "./EthereumWallet.js"
import { RecordingJsonRpcProvider } from "./RecordingJsonRpcProvider.js"

/**
 * Client for the Ethereum outpost on anvil/hardhat. Loads (and caches)
 * contracts and exposes the anvil control surface (`mine`, `advanceTime`,
 * `setBalance`) plus OPP event queries. `getContract` is get-or-load, cached by
 * `(name, address)`.
 */
export class EthereumClient {
  readonly provider: ethers.JsonRpcProvider
  private deployerWallet: EthereumWallet | null = null
  /** Keyed `${name}@${address}` so the same name at a new address re-binds. */
  private readonly contracts = new Map<string, ethers.Contract>()

  constructor(
    readonly rpcUrl: string,
    readonly dataPath: string
  ) {
    // Recording provider: every tx submission / anvil admin call made through
    // this client (or any signer/contract bound to it) lands in the running
    // step's `Report.StepResult.extra`.
    // Local chains can mine between identical requests in the same event loop.
    // Even a rejected gas estimate must observe the new state after a receipt.
    this.provider = new RecordingJsonRpcProvider(rpcUrl, undefined, {
      cacheTimeout: EthereumClient.ProviderCacheTimeoutMs
    })
  }

  /**
   * The cluster's DEPLOYER wallet, connected to this provider — the outpost
   * manager's admin, and the signer every contract bound through
   * {@link getContract} sends with. It is the persisted
   * `EthereumWallet.DeployerWalletName` wallet under the cluster data path,
   * created by the Ethereum outpost phase before any write goes through this
   * client, and loaded lazily on first use.
   *
   * @throws If the deployer wallet has not been created yet.
   */
  get wallet(): EthereumWallet {
    return (this.deployerWallet ??= new EthereumWallet(
      this.provider,
      EthereumWallet.loadWallet(
        this.dataPath,
        EthereumWallet.DeployerWalletName
      ).privateKey
    ))
  }

  /**
   * Get-or-load a signer-connected contract instance, cached by `(name, address)`.
   *
   * @param name - Logical contract name (cache key half).
   * @param address - Deployed address (cache key half).
   * @param abi - Contract ABI.
   * @returns The cached or newly-bound contract.
   */
  getContract(
    name: string,
    address: string,
    abi: ethers.InterfaceAbi
  ): ethers.Contract {
    const key = `${name}@${address}`
    const hit = this.contracts.get(key)
    if (hit != null) return hit
    const contract = new ethers.Contract(address, abi, this.wallet.signer)
    this.contracts.set(key, contract)
    return contract
  }

  /** Current block number. */
  getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber()
  }

  /** ETH (wei) balance of an address. */
  getBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address)
  }

  /**
   * Set an address's ETH balance (anvil `anvil_setBalance`) — the local
   * chain's faucet, the counterpart of the Solana validator's airdrop. The ONE
   * way the harness funds an account on the run anvil: no genesis account is
   * drawn from and no key derived to pay from.
   *
   * @param address - The account to fund.
   * @param balanceWei - The balance to set, in wei.
   */
  async setBalance(address: string, balanceWei: bigint): Promise<void> {
    await this.provider.send(EthereumClient.SetBalanceMethod, [
      address,
      ethers.toBeHex(balanceWei)
    ])
  }

  /** Mine `blocks` blocks (anvil `evm_mine`). */
  async mine(blocks = 1): Promise<void> {
    await Promise.all(
      Array.from({ length: blocks }, () => this.provider.send("evm_mine", []))
    )
  }

  /** Advance anvil time by `seconds`, then mine. */
  async advanceTime(seconds: number): Promise<void> {
    await this.provider.send("evm_increaseTime", [seconds])
    await this.mine()
  }

  /** Query `OPPEnvelope` events from a contract. */
  getOPPEnvelopes(
    opp: ethers.Contract,
    fromBlock = 0
  ): Promise<ethers.EventLog[]> {
    return this.queryEvents(opp, EthereumClient.OppEnvelopeEvent, fromBlock)
  }

  private async queryEvents(
    contract: ethers.Contract,
    eventName: string,
    fromBlock: number
  ): Promise<ethers.EventLog[]> {
    const events = await contract.queryFilter(
      contract.filters[eventName](),
      fromBlock
    )
    return events.filter(
      (event): event is ethers.EventLog => event instanceof ethers.EventLog
    )
  }
}

export namespace EthereumClient {
  /** Disable ethers' request cache so local mined state is visible immediately. */
  export const ProviderCacheTimeoutMs = -1
  /** The anvil RPC that sets an account's balance outright. */
  export const SetBalanceMethod = "anvil_setBalance"
  /** OPP envelope event name on the outpost contract. */
  export const OppEnvelopeEvent = "OPPEnvelope"
}
