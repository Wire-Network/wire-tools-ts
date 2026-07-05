import { ethers } from "ethers"

/** The harness's signer wrapper for the Ethereum outpost. */
export class EthereumWallet {
  readonly signer: ethers.Wallet

  constructor(provider: ethers.JsonRpcProvider, privateKey: string) {
    this.signer = new ethers.Wallet(privateKey, provider)
  }

  /** The signer's 0x address. */
  get address(): string {
    return this.signer.address
  }
}
