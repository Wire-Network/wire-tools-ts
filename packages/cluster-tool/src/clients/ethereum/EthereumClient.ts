import { ethers } from "ethers"
import { EthereumWallet } from "./EthereumWallet.js"
import { RecordingJsonRpcProvider } from "./RecordingJsonRpcProvider.js"

/**
 * Client for the Ethereum outpost on anvil/hardhat. Loads (and caches)
 * contracts and exposes the anvil control surface (`mine`, `advanceTime`) plus
 * OPP event queries. `getContract` is get-or-load, cached by `(name, address)`.
 */
export class EthereumClient {
  readonly provider: ethers.JsonRpcProvider
  readonly wallet: EthereumWallet
  /** Keyed `${name}@${address}` so the same name at a new address re-binds. */
  private readonly contracts = new Map<string, ethers.Contract>()

  constructor(
    readonly rpcUrl: string,
    privateKey: string | null = null
  ) {
    // Recording provider: every tx submission / anvil admin call made through
    // this client (or any signer/contract bound to it) lands in the running
    // step's `Report.StepResult.extra`.
    this.provider = new RecordingJsonRpcProvider(rpcUrl)
    this.wallet = new EthereumWallet(
      this.provider,
      privateKey ?? EthereumClient.DefaultPrivateKey
    )
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

  /** The chain id the connected RPC endpoint reports (endpoint-liveness probe). */
  async chainId(): Promise<number> {
    return Number((await this.provider.getNetwork()).chainId)
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
  /** anvil account #0 private key — deterministic; only used when none is supplied. */
  export const DefaultPrivateKey =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  /** OPP envelope event name on the outpost contract. */
  export const OppEnvelopeEvent = "OPPEnvelope"
}
