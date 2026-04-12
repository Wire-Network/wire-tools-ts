import { ethers } from "ethers"
import { log } from "../logger.js"

/**
 * Client for interacting with an Ethereum outpost on anvil/hardhat.
 * Loads contract ABIs and provides typed access to OPP contracts.
 */
export class ETHClient {
  public provider: ethers.JsonRpcProvider
  public signer: ethers.Wallet
  private contracts: Map<string, ethers.Contract> = new Map()

  constructor(
    public readonly rpcUrl: string,
    privateKey?: string
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl)
    this.signer = new ethers.Wallet(
      privateKey || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // anvil default key 0
      this.provider
    )
  }

  /** Load a contract from its ABI JSON file and deployed address. */
  loadContract(name: string, address: string, abi: any): ethers.Contract {
    const contract = new ethers.Contract(address, abi, this.signer)
    this.contracts.set(name, contract)
    return contract
  }

  /** Get a previously loaded contract. */
  getContract(name: string): ethers.Contract {
    const c = this.contracts.get(name)
    if (!c) throw new Error(`Contract "${name}" not loaded`)
    return c
  }

  /** Get current block number. */
  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber()
  }

  /** Get ETH balance of an address. */
  async getBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address)
  }

  /** Mine a block (anvil). */
  async mine(blocks = 1): Promise<void> {
    await this.provider.send("evm_mine", [])
  }

  /** Advance time by seconds (anvil). */
  async advanceTime(seconds: number): Promise<void> {
    await this.provider.send("evm_increaseTime", [seconds])
    await this.mine()
  }

  /** Query OPP message events from a contract. */
  async getOPPEnvelopes(
    oppContract: ethers.Contract,
    fromBlock = 0
  ): Promise<ethers.EventLog[]> {
    const filter = oppContract.filters.OPPEnvelope()
    const events = await oppContract.queryFilter(filter, fromBlock)
    return events.filter((e): e is ethers.EventLog => e instanceof ethers.EventLog)
  }

  /** Query OPP epoch events from a contract. */
  async getOPPEpochs(
    oppContract: ethers.Contract,
    fromBlock = 0
  ): Promise<ethers.EventLog[]> {
    const filter = oppContract.filters.OPPEpoch()
    const events = await oppContract.queryFilter(filter, fromBlock)
    return events.filter((e): e is ethers.EventLog => e instanceof ethers.EventLog)
  }
}
