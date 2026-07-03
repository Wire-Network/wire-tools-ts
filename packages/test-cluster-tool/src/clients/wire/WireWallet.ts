import Fs from "node:fs"
import Path from "node:path"
import { flatten } from "lodash"
import { asOption } from "@3fv/prelude-ts"
import { getLogger } from "@wireio/shared"
import { eachSeries } from "../../utils/asyncUtils.js"
import { isNotEmpty } from "../../utils/predicateUtils.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { ClioRunner } from "./clio/ClioRunner.js"

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
  get password(): string | null {
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

export namespace WireWallet {
  export const DefaultName = "default"
  export const Subpath = "wallet"
  export const PasswordFilename = "wallet.pw"
  /** Captures the `PW…` console password from `wallet create --to-console`. */
  export const PasswordPattern = /"(PW[A-Za-z0-9]+)"/
  /** Benign "wallet already open" signatures across clio/kiod versions. */
  export const AlreadyOpenPattern = /Already|already open|cannot open/

  /** A clio error's message (`message ?? stderr ?? ""`) — every catch reads it through here. */
  export function errorMessage(error: unknown): string {
    return asOption(error as { message?: unknown; stderr?: unknown })
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
