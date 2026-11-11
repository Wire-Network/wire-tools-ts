import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { KeyType } from "@wireio/sdk-core"
import { EthereumWallet } from "@wireio/cluster-tool/clients/ethereum"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import type { EthereumKeyPair } from "@wireio/cluster-tool/types"
import { ethereumKeyPairFromWallet, toURL } from "@wireio/cluster-tool/utils"

/** A random EM pair — what `KeyGenerator.create(KeyType.EM, …)` mints. */
const randomKeyPair = (): EthereumKeyPair =>
  ethereumKeyPairFromWallet(ethers.Wallet.createRandom())
/** A flow-owned handle. */
const HolderWalletName = "holder"
/** A handle no test persists. */
const AbsentWalletName = "absent"
/** The permission bits a `stat` mode carries. */
const FileModeMask = 0o777
/** The message an offline signer signs to prove it holds the stored secret. */
const SignedMessage = "createlink"

describe("EthereumWallet", () => {
  let dataPath: string, provider: ethers.JsonRpcProvider

  beforeAll(async () => {
    // Never dialed — only used to connect a loaded signer; still resolved
    // through the registry per bind-available-ports-not-fixed.
    provider = new ethers.JsonRpcProvider(
      toURL(
        await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
      )
    )
  })

  afterAll(() => {
    provider.destroy()
  })

  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-wallet-"))
  })

  afterEach(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  it("names the two bootstrap handles — the deployer and the panic account — distinctly", () => {
    expect(EthereumWallet.DeployerWalletName).toBe("deployer")
    expect(EthereumWallet.PanicWalletName).toBe("panic")
    expect(EthereumWallet.DeployerWalletName).not.toBe(
      EthereumWallet.PanicWalletName
    )
  })

  it("walletFile composes <dataPath>/eth-<name>-wallet.json from the prefix and suffix", () => {
    expect(EthereumWallet.walletFile(dataPath, HolderWalletName)).toBe(
      Path.join(
        dataPath,
        `${EthereumWallet.WalletFilePrefix}${HolderWalletName}${EthereumWallet.WalletFileSuffix}`
      )
    )
    expect(EthereumWallet.walletFile(dataPath, HolderWalletName)).toBe(
      Path.join(dataPath, "eth-holder-wallet.json")
    )
  })

  it("hasWallet reports a handle only once it is persisted", () => {
    expect(EthereumWallet.hasWallet(dataPath, HolderWalletName)).toBe(false)
    EthereumWallet.saveWallet(dataPath, HolderWalletName, randomKeyPair())
    expect(EthereumWallet.hasWallet(dataPath, HolderWalletName)).toBe(true)
    expect(EthereumWallet.hasWallet(dataPath, AbsentWalletName)).toBe(false)
  })

  it("saveWallet persists the pair owner-only, creating the data dir, and returns it read back", () => {
    const nested = Path.join(dataPath, "cluster", "data"),
      pair = randomKeyPair(),
      saved = EthereumWallet.saveWallet(nested, HolderWalletName, pair),
      file = EthereumWallet.walletFile(nested, HolderWalletName)
    expect(saved).toEqual(pair)
    expect(saved).toEqual(EthereumWallet.loadKeyPair(nested, HolderWalletName))
    expect(Fs.statSync(file).mode & FileModeMask).toBe(
      EthereumWallet.WalletFileMode
    )
    // The stored document IS the pair — the shape `KeyGenerator` minted.
    expect(JSON.parse(Fs.readFileSync(file, "utf8"))).toEqual(pair)
  })

  it("saveWallet refuses to replace a wallet already persisted under the handle", () => {
    const first = EthereumWallet.saveWallet(
      dataPath,
      HolderWalletName,
      randomKeyPair()
    )
    expect(() =>
      EthereumWallet.saveWallet(dataPath, HolderWalletName, randomKeyPair())
    ).toThrow(/Ethereum wallet "holder" already exists/)
    // The identity a consumer may already have loaded never changes underneath it.
    expect(EthereumWallet.loadKeyPair(dataPath, HolderWalletName)).toEqual(first)
  })

  it("loadKeyPair re-derives the public half and the address from the stored secret", () => {
    const pair = randomKeyPair()
    EthereumWallet.saveWallet(dataPath, HolderWalletName, pair)
    const loaded = EthereumWallet.loadKeyPair(dataPath, HolderWalletName)
    expect(loaded.type).toBe(KeyType.EM)
    expect(loaded.privateKey).toBe(pair.privateKey)
    expect(loaded.publicKey).toBe(pair.publicKey)
    expect(loaded.address).toBe(pair.address)
  })

  it("loadKeyPair throws for a handle that was never created", () => {
    expect(() => EthereumWallet.loadKeyPair(dataPath, AbsentWalletName)).toThrow(
      /Ethereum wallet "absent" not found/
    )
  })

  it("loadKeyPair refuses a file whose public key does not match its secret", () => {
    const pair = randomKeyPair(),
      other = randomKeyPair()
    Fs.writeFileSync(
      EthereumWallet.walletFile(dataPath, HolderWalletName),
      JSON.stringify({ ...pair, publicKey: other.publicKey })
    )
    expect(() => EthereumWallet.loadKeyPair(dataPath, HolderWalletName)).toThrow(
      /Ethereum wallet "holder" public key does not match its secret/
    )
  })

  it("loadKeyPair refuses a file whose address does not match its secret", () => {
    const pair = randomKeyPair(),
      other = randomKeyPair()
    Fs.writeFileSync(
      EthereumWallet.walletFile(dataPath, HolderWalletName),
      JSON.stringify({ ...pair, address: other.address })
    )
    expect(() => EthereumWallet.loadKeyPair(dataPath, HolderWalletName)).toThrow(
      /Ethereum wallet "holder" address does not match its secret/
    )
  })

  it("loadWallet yields the handle's signer — connected to the given provider, offline without one", async () => {
    const pair = randomKeyPair(),
      source = ethers.Wallet.createRandom()
    // Persist the SOURCE wallet's pair so the offline signature can be compared.
    EthereumWallet.saveWallet(
      dataPath,
      HolderWalletName,
      ethereumKeyPairFromWallet(source)
    )
    EthereumWallet.saveWallet(dataPath, EthereumWallet.PanicWalletName, pair)
    const connected = EthereumWallet.loadWallet(
        dataPath,
        EthereumWallet.PanicWalletName,
        provider
      ),
      offline = EthereumWallet.loadWallet(dataPath, HolderWalletName)
    expect(connected.address).toBe(pair.address)
    expect(connected.provider).toBe(provider)
    expect(offline.address).toBe(source.address)
    expect(offline.provider).toBeNull()
    expect(await offline.signMessage(SignedMessage)).toBe(
      await source.signMessage(SignedMessage)
    )
  })

  it("loadWallet throws for a handle that was never created", () => {
    expect(() =>
      EthereumWallet.loadWallet(dataPath, AbsentWalletName, provider)
    ).toThrow(/Ethereum wallet "absent" not found/)
  })

  it("the EthereumWallet class wraps a signer bound to the provider and exposes its address", () => {
    const source = ethers.Wallet.createRandom(),
      wallet = new EthereumWallet(provider, source.privateKey)
    expect(wallet.address).toBe(source.address)
    expect(wallet.signer.address).toBe(source.address)
    expect(wallet.signer.provider).toBe(provider)
  })
})
