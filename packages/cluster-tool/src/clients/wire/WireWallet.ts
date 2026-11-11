import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { flatten } from "lodash"
import { asOption } from "@3fv/prelude-ts"
import { KeyType } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import type { WireKeyPair } from "../../types/KeyPair.js"
import { eachSeries } from "../../utils/asyncUtils.js"
import { keyPairFromPrivate } from "../../utils/keyPairUtils.js"
import { isNotEmpty } from "../../utils/predicateUtils.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { ClioRunner, type ClioError } from "./clio/ClioRunner.js"

const log = getLogger("WireWallet")

/**
 * The kiod wallet — extracted from the old `Clio.wallet*`. Every mutator returns
 * `Promise<WireWallet>` (fluent). The password is loaded from disk as a VALUE in
 * the constructor (never an `ifSome` side effect), and benign idempotency states
 * ("already open" / "already unlocked") are tolerated through the namespace
 * helpers, not inline `try/catch` branches.
 */
export class WireWallet {
  private passwordInternal: string | null

  constructor(
    private readonly runner: ClioRunner,
    readonly walletPath: string = Path.join(
      runner.config.clusterPath,
      WireWallet.Subpath
    ),
    readonly passwordFile: string = Path.join(
      walletPath,
      WireWallet.PasswordFilename
    )
  ) {
    // Load the persisted password as a VALUE — never asOption().ifSome().
    this.passwordInternal = asOption(passwordFile)
      .filter(Fs.existsSync)
      .map(file => Fs.readFileSync(file, "utf8").trim())
      .getOrNull()
  }

  /** The captured wallet password, or null if none has been created/persisted. */
  get password(): string {
    return this.passwordInternal
  }

  /** Persist + cache the password (creating the wallet dir). Fluent. */
  private persistPassword(value: string): WireWallet {
    mkdirs(this.walletPath)
    Fs.writeFileSync(this.passwordFile, value, "utf8")
    this.passwordInternal = value
    return this
  }

  /**
   * Create the named wallet if absent (idempotent), capturing its `PW…`. Fluent.
   *
   * @param walletId - Wallet name. Defaults to {@link WireWallet.DefaultName}.
   * @returns This wallet.
   */
  async getOrCreate(
    walletId: string = WireWallet.DefaultName
  ): Promise<WireWallet> {
    const result = await this.runner
      .run(["wallet", "create", "-n", walletId, "--to-console"])
      .catch(error =>
        WireWallet.tolerate(
          error,
          ClioRunner.ErrorFragment.AccountAlreadyExists,
          ""
        )
      )
    // VALUE flow off the capture group — persist when matched, else no-op.
    return asOption(result.match(WireWallet.PasswordPattern))
      .map(([, password]) => this.persistPassword(password))
      .getOrElse(this)
  }

  /**
   * Import one or more `PVT_*` keys (accepts arrays). Fluent.
   *
   * @param privateKeys - Keys to import (flattened; empties skipped).
   * @returns This wallet.
   */
  async addPrivateKey(
    ...privateKeys: Array<string | readonly string[]>
  ): Promise<WireWallet> {
    await eachSeries(flatten(privateKeys).filter(isNotEmpty), key =>
      this.runner.run([
        "wallet",
        "import",
        "-n",
        WireWallet.DefaultName,
        "--private-key",
        key
      ])
    )
    return this
  }

  /**
   * Open + unlock the wallet (idempotent; benign "already" states logged +
   * swallowed). Fluent.
   *
   * @param password - Override the cached password.
   * @returns This wallet.
   */
  async unlock(password: string | null = this.password): Promise<WireWallet> {
    await this.open()
    await this.runner
      .run([
        "wallet",
        "unlock",
        "-n",
        WireWallet.DefaultName,
        "--password",
        password ?? ""
      ])
      .catch(error =>
        WireWallet.swallowBenign(
          error,
          ClioRunner.ErrorFragment.WalletAlreadyUnlocked,
          "wallet already unlocked"
        )
      )
    return this
  }

  /** Load the wallet file into kiod (idempotent; benign "already open" swallowed). */
  private async open(walletId: string = WireWallet.DefaultName): Promise<void> {
    await this.runner
      .run(["wallet", "open", "-n", walletId])
      .catch(error =>
        WireWallet.swallowBenign(
          error,
          WireWallet.AlreadyOpenPattern,
          "wallet already open"
        )
      )
  }
}

/**
 * The kiod wallet's constants and error helpers, plus the harness's PERSISTED
 * per-cluster WIRE keys by durable handle — the K1 counterpart of
 * `EthereumWallet.saveWallet` / `loadKeyPair` and
 * `SolanaFundingTool.createKeypair` / `loadKeypair`. A WIRE identity the
 * harness must hold BEFORE a cluster exists (a pre-created batch operator's
 * account key, which the bootstrap then adopts) is a freshly random pair
 * written once under its handle and read back verbatim by every later
 * consumer: reproducible from its own stored secret and from nothing else.
 */
export namespace WireWallet {
  export const DefaultName = "default"
  export const Subpath = "wallet"
  export const PasswordFilename = "wallet.pw"
  /** Captures the `PW…` console password from `wallet create --to-console`. */
  export const PasswordPattern = /"(PW[A-Za-z0-9]+)"/
  /** Benign "wallet already open" signatures across clio/kiod versions. */
  export const AlreadyOpenPattern = /Already|already open|cannot open/
  /** Filename prefix of a persisted per-cluster WIRE key. */
  export const KeyFilePrefix = "wire-"
  /** Filename suffix of a persisted per-cluster WIRE key. */
  export const KeyFileSuffix = "-key.json"
  /** File mode of a persisted key: owner read/write only. */
  export const KeyFileMode = 0o600

  /**
   * Absolute path to a per-cluster WIRE key file (`<dataPath>/wire-<name>-key.json`).
   * Every consumer resolves the path through this function so they load the SAME
   * key for a given handle.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The key's durable handle (an operator's label).
   * @returns Absolute path to the key JSON file.
   */
  export function keyFile(dataPath: string, name: string): string {
    return Path.join(dataPath, `${KeyFilePrefix}${name}${KeyFileSuffix}`)
  }

  /**
   * Whether a per-cluster WIRE key has been persisted under `name`.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The key's durable handle.
   * @returns `true` when the key file exists.
   */
  export function hasKey(dataPath: string, name: string): boolean {
    return Fs.existsSync(keyFile(dataPath, name))
  }

  /**
   * Persist a freshly generated WIRE key under `name` (owner-only mode). The pair
   * comes from `KeyGenerator.create(KeyType.K1, …)` — the one generation facade —
   * never from an inline derivation; this only stores it. Refuses to replace a key
   * already persisted under the handle, so an identity never silently changes
   * under a consumer that loaded it earlier.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The key's durable handle.
   * @param keyPair - The generated pair to persist.
   * @returns The persisted pair, read back through {@link loadKeyPair}.
   * @throws If a key already exists under `name`.
   */
  export function saveKey(
    dataPath: string,
    name: string,
    keyPair: WireKeyPair
  ): WireKeyPair {
    const file = keyFile(dataPath, name)
    Assert.ok(
      !Fs.existsSync(file),
      `WireWallet: WIRE key "${name}" already exists at ${file}`
    )
    mkdirs(Path.dirname(file))
    Fs.writeFileSync(file, JSON.stringify(keyPair), {
      mode: KeyFileMode,
      flag: "wx"
    })
    return loadKeyPair(dataPath, name)
  }

  /**
   * Load a persisted per-cluster WIRE key by handle as its stored key pair,
   * re-deriving the public half from the secret so a tampered or truncated file
   * is refused rather than trusted.
   *
   * @param dataPath - The cluster data directory.
   * @param name - The key's durable handle.
   * @returns The stored key pair.
   * @throws If the key has not been created yet, or its halves disagree.
   */
  export function loadKeyPair(dataPath: string, name: string): WireKeyPair {
    const file = keyFile(dataPath, name)
    Assert.ok(
      Fs.existsSync(file),
      `WireWallet: WIRE key "${name}" not found at ${file}`
    )
    const saved = JSON.parse(Fs.readFileSync(file, "utf8")) as WireKeyPair,
      // A `PVT_K1_…` string IS the curve's native form, so it parses as-is.
      keyPair = keyPairFromPrivate(KeyType.K1, saved.privateKey)
    Assert.strictEqual(
      keyPair.publicKey,
      saved.publicKey,
      `WireWallet: WIRE key "${name}" public key does not match its secret`
    )
    return keyPair
  }

  /** A clio error's message (`message ?? stderr ?? ""`) — every catch reads it through here. */
  export function errorMessage(error: unknown): string {
    return asOption(error as ClioError)
      .map(e => String(e?.message ?? e?.stderr ?? ""))
      .getOrElse("")
  }

  /**
   * Re-throw unless the message matches `benign`; on a benign match return
   * `fallback`. No if/throw.
   *
   * @param error - The caught error.
   * @param benign - The benign fragment to tolerate.
   * @param fallback - The value to return on a benign match.
   * @returns `fallback` when benign.
   * @throws The original error when not benign.
   */
  export function tolerate<T>(error: unknown, benign: string, fallback: T): T {
    return asOption(errorMessage(error))
      .filter(message => message.includes(benign))
      .match({
        Some: () => fallback,
        None: () => {
          throw error
        }
      })
  }

  /**
   * Log + swallow a benign error (message matches `benign`), else re-throw. No
   * if/throw.
   *
   * @param error - The caught error.
   * @param benign - Fragment (string) or pattern (RegExp) to tolerate.
   * @param debugMessage - What to log on a benign match.
   * @throws The original error when not benign.
   */
  export function swallowBenign(
    error: unknown,
    benign: string | RegExp,
    debugMessage: string
  ): void {
    asOption(errorMessage(error))
      .filter(message =>
        typeof benign === "string" ? message.includes(benign) : benign.test(message)
      )
      .match({
        Some: () => log.debug(debugMessage),
        None: () => {
          throw error
        }
      })
  }
}
