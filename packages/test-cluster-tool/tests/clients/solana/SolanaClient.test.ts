import { Keypair } from "@solana/web3.js"
import { getAccount, TokenAccountNotFoundError } from "@solana/spl-token"
import {
  SolanaClient,
  SolanaWallet
} from "@wireio/test-cluster-tool/clients/solana"
import { BindConfig } from "@wireio/test-cluster-tool/config"
import { toURL } from "@wireio/test-cluster-tool/utils"

jest.mock("@solana/spl-token", () => ({
  ...jest.requireActual("@solana/spl-token"),
  getAccount: jest.fn()
}))

const newWallet = () => new SolanaWallet(Keypair.generate())

describe("SolanaClient", () => {
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(await BindConfig.findAvailable(BindConfig.DefaultSolanaRpc))
  })

  it("opens a connection at the given rpc url", () => {
    const client = new SolanaClient(rpcUrl, newWallet())
    expect(client.connection.rpcEndpoint).toBe(rpcUrl)
  })

  it("exposes the wallet's public key", () => {
    const wallet = newWallet()
    const client = new SolanaClient(rpcUrl, wallet)
    expect(client.wallet.publicKey.equals(wallet.publicKey)).toBe(true)
  })

  it("keeps the default commitment in lock-step with ConfirmationStatus.Confirmed", () => {
    expect(SolanaClient.DefaultCommitment).toBe(
      SolanaClient.ConfirmationStatus.confirmed
    )
  })

  it("getSplBalance returns the ATA's raw token amount", async () => {
    jest
      .mocked(getAccount)
      .mockResolvedValueOnce({ amount: 123n } as Awaited<ReturnType<typeof getAccount>>)
    const client = new SolanaClient(rpcUrl, newWallet())
    await expect(
      client.getSplBalance(Keypair.generate().publicKey)
    ).resolves.toBe(123n)
  })

  it("getSplBalance is 0n when the associated token account does not exist", async () => {
    jest
      .mocked(getAccount)
      .mockRejectedValueOnce(new TokenAccountNotFoundError())
    const client = new SolanaClient(rpcUrl, newWallet())
    await expect(
      client.getSplBalance(Keypair.generate().publicKey)
    ).resolves.toBe(0n)
  })
})

describe("SolanaWallet", () => {
  it("round-trips a secret key", () => {
    const keypair = Keypair.generate()
    const wallet = SolanaWallet.fromSecretKey(keypair.secretKey)
    expect(wallet.publicKey.equals(keypair.publicKey)).toBe(true)
  })
})
