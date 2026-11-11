import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import type { EthereumKeyPair } from "../../types/KeyPair.js"
import { mkdirs } from "../../utils/fsUtils.js"
import {
  ethereumPrivateKeyHex,
  keyPairFromPrivate
} from "../../utils/keyPairUtils.js"

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

/**
 * The harness's PERSISTED per-cluster Ethereum wallets, by durable handle — the
 * exact counterpart of `SolanaFundingTool.createKeypair` / `loadKeypair`. Every
 * local-chain actor the harness itself acts as (the outpost deployer, the
 * emergency-stop panic account, a flow's holder) is a freshly RANDOM wallet
 * created once under its handle and read back verbatim by every later consumer,
 * so the identity is reproducible from its own stored secret and from nothing
 * else: no mnemonic, no HD index, no anvil genesis account.
 */
export namespace EthereumWallet {
  /** Filename prefix of a persisted per-cluster Ethereum wallet. */
  export const WalletFilePrefix = "eth-"
  /** Filename suffix of a persisted per-cluster Ethereum wallet. */
  export const WalletFileSuffix = "-wallet.json"
  /** File mode of a persisted wallet: owner read/write only. */
  export const WalletFileMode = 0o600
  /**
   * Durable handle of the local outpost DEPLOYER: `deployLocal.ts`'s `owner`,
   * the `OutpostManager` admin after handoff, and the signer behind
   * `EthereumClient.wallet`.
   */
  export const DeployerWalletName = "deployer"
  /**
   * Durable handle of the emergency-stop PANIC account the deploy config names
   * (`panicAccount`), which the deploy grants the `panic` role: `pause()` /
   * `unpause()` on the pausable contracts and nothing else.
   */
  export const PanicWalletName = "panic"

  /**
   * Absolute path to a per-cluster Ethereum wallet file
   * (`<dataPath>/eth-<name>-wallet.json`). Every consumer resolves the path
   * through this function so they load the SAME wallet for a given handle.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The wallet's durable handle (e.g. {@link DeployerWalletName}).
   * @returns Absolute path to the wallet JSON file.
   */
  export function walletFile(dataPath: string, name: string): string {
    return Path.join(dataPath, `${WalletFilePrefix}${name}${WalletFileSuffix}`)
  }

  /**
   * Whether a per-cluster Ethereum wallet has been persisted under `name`.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The wallet's durable handle.
   * @returns `true` when the wallet file exists.
   */
  export function hasWallet(dataPath: string, name: string): boolean {
    return Fs.existsSync(walletFile(dataPath, name))
  }

  /**
   * Persist a freshly generated wallet under `name` (owner-only mode). The pair
   * comes from `KeyGenerator.create(KeyType.EM, …)` — the one generation facade
   * — never from an inline derivation; this only stores it. Refuses to replace a
   * wallet already persisted under the handle, so an identity never silently
   * changes under a consumer that loaded it earlier.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The wallet's durable handle.
   * @param keyPair - The generated pair to persist.
   * @returns The persisted pair, read back through {@link loadKeyPair}.
   * @throws If a wallet already exists under `name`.
   */
  export function saveWallet(
    dataPath: string,
    name: string,
    keyPair: EthereumKeyPair
  ): EthereumKeyPair {
    const file = walletFile(dataPath, name)
    Assert.ok(
      !Fs.existsSync(file),
      `EthereumWallet: Ethereum wallet "${name}" already exists at ${file}`
    )
    mkdirs(Path.dirname(file))
    Fs.writeFileSync(file, JSON.stringify(keyPair), {
      mode: WalletFileMode,
      flag: "wx"
    })
    return loadKeyPair(dataPath, name)
  }

  /**
   * Load a persisted per-cluster Ethereum wallet by handle as its stored key
   * pair, re-deriving the public half from the secret so a tampered or
   * truncated file is refused rather than trusted.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The wallet's durable handle.
   * @returns The stored key pair.
   * @throws If the wallet has not been created yet, or its halves disagree.
   */
  export function loadKeyPair(dataPath: string, name: string): EthereumKeyPair {
    const file = walletFile(dataPath, name)
    Assert.ok(
      Fs.existsSync(file),
      `EthereumWallet: Ethereum wallet "${name}" not found at ${file}`
    )
    const saved = JSON.parse(Fs.readFileSync(file, "utf8")) as EthereumKeyPair,
      wallet = keyPairFromPrivate(
        KeyType.EM,
        PrivateKey.from(saved.privateKey).toNativeString()
      )
    Assert.strictEqual(
      wallet.publicKey,
      saved.publicKey,
      `EthereumWallet: Ethereum wallet "${name}" public key does not match its secret`
    )
    Assert.strictEqual(
      wallet.address,
      saved.address,
      `EthereumWallet: Ethereum wallet "${name}" address does not match its secret`
    )
    return wallet
  }

  /**
   * Load a persisted per-cluster Ethereum wallet by handle as a live ethers
   * wallet — connected to `provider` when one is given; without one it can only
   * sign offline, never send. A persisted wallet always carries its material
   * (it is a LOCAL actor — the deployer, the panic account, a flow's holder),
   * which is why this returns a concrete `ethers.Wallet` rather than going
   * through the custody facade `keyPairUtils.ethereumSigner`.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The wallet's durable handle.
   * @param provider - The provider to connect the wallet to.
   * @returns The wallet.
   * @throws If the wallet has not been created yet.
   */
  export function loadWallet(
    dataPath: string,
    name: string,
    provider?: ethers.Provider
  ): ethers.Wallet {
    return new ethers.Wallet(
      ethereumPrivateKeyHex(loadKeyPair(dataPath, name)),
      provider
    )
  }
}
