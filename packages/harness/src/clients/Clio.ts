import { execFile } from "child_process"
import { promisify } from "util"
import { log } from "../logger.js"
import { asOption } from "@3fv/prelude-ts"
import { isEmpty, negate } from "lodash"
import { isNotEmpty } from "../util"
import { WIREChainInfo } from "./WIREClient"
import { isString } from "@wireio/shared"

const execFileAsync = promisify(execFile)

export interface ClioConfig {
  /** Path to clio binary */
  binary: string
  /** nodeop URL (default: http://127.0.0.1:8888) */
  url: string
  /** kiod wallet URL (default: unix socket) */
  walletUrl?: string
}

export interface ClioRunOptions {
  json?: boolean
}

/**
 * TypeScript wrapper around the `clio` CLI tool.
 * Mirrors the patterns used by cluster_manager.py's Node.publishContract().
 */
export class Clio {
  constructor(private config: ClioConfig) {}

  /** Run a clio command and return parsed JSON (or raw stdout). */
  private async run<T extends {}>(
    args: string[],
    opts: { json: true }
  ): Promise<T>
  private async run(args: string[], opts?: { json?: false }): Promise<string>
  private async run(
    args: string[],
    opts: ClioRunOptions = { json: false }
  ): Promise<any> {
    const fullArgs = [
      "-u",
      this.config.url,
      ...(this.config.walletUrl ? ["--wallet-url", this.config.walletUrl] : []),
      "-v",
      ...args
    ]

    log.info(`clio ${fullArgs.join(" ")}`)

    try {
      const { stdout, stderr } = await execFileAsync(
        this.config.binary,
        fullArgs,
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000
        }
      )
      asOption(stderr)
        .filter(isNotEmpty)
        .ifSome(stderr => log.debug(`clio stderr:`, stderr))

      if (!!opts.json) {
        try {
          return JSON.parse(stdout)
        } catch {
          return stdout.trim()
        }
      }
      return stdout.trim()
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? "",
        stdout = err.stdout?.toString() ?? ""
      asOption(stdout)
        .filter(isNotEmpty)
        .ifSome(out => log.error(`clio stdout: `, out))
      log.error(`clio failed: ${stderr}`, err)

      throw err
    }
  }

  // ── Wallet ──

  async walletCreate(name: string): Promise<string> {
    const result = await this.run(
      ["wallet", "create", "-n", name, "--to-console"],
      { json: false }
    )
    // Extract the password from stdout
    const match = result.match(/"(PW[A-Za-z0-9]+)"/)
    return match ? match[1] : result
  }

  async walletImportKey(walletName: string, privateKey: string): Promise<void> {
    await this.run(
      ["wallet", "import", "-n", walletName, "--private-key", privateKey],
      { json: false }
    )
  }

  async walletUnlock(walletName: string, password: string): Promise<void> {
    await this.run(
      ["wallet", "unlock", "-n", walletName, "--password", password],
      { json: false }
    )
  }

  // ── Account ──

  /**
   * Create a new account on the WIRE chain.
   * @param creator - Account that creates the new account (typically "sysio")
   * @param name - New account name
   * @param ownerKey - Owner public key
   * @param activeKey - Active public key (defaults to ownerKey)
   */
  async createAccount(
    creator: string,
    name: string,
    ownerKey: string,
    activeKey?: string
  ): Promise<string> {
    return this.run([
      "create",
      "account",
      creator,
      name,
      ownerKey,
      activeKey || ownerKey
    ])
  }

  async createSystemAccount(name: string, ownerKey: string): Promise<string> {
    return this.createAccount("sysio", name, ownerKey)
  }

  // ── Contract deployment ──

  async setCode(account: string, wasmPath: string): Promise<string> {
    return this.run([
      "set",
      "code",
      account,
      wasmPath,
      "-p",
      `${account}@active`
    ])
  }

  async setAbi(account: string, abiPath: string): Promise<string> {
    return this.run(["set", "abi", account, abiPath, "-p", `${account}@active`])
  }

  async setContract(
    account: string,
    contractDir: string,
    wasmFile: string,
    abiFile: string
  ): Promise<string> {
    return this.run([
      "set",
      "contract",
      account,
      contractDir,
      wasmFile,
      abiFile,
      "-p",
      `${account}@active`
    ])
  }

  // ── Actions ──
  async pushAction<T extends {}, R extends {}>(
    account: string,
    action: string,
    data: T,
    auth: string
  ): Promise<R>
  async pushAction(
    account: string,
    action: string,
    data: string | {},
    auth: string
  ): Promise<string>
  async pushAction(
    account: string,
    action: string,
    data: string | {},
    auth: string
  ): Promise<string> {
    const jsonFlag = !isString(data),
      dataStr = jsonFlag ? JSON.stringify(data) : data
    return this.run(
      [
        "push",
        "action",
        account,
        action,
        dataStr,
        "-p",
        auth,
        jsonFlag && "--json"
      ]
        .filter(isString)
        .filter(isNotEmpty)
    )
  }

  // ── Privileged ──

  async setPriv(account: string): Promise<string> {
    return this.pushAction(
      "sysio",
      "setpriv",
      JSON.stringify({ account, is_priv: 1 }),
      "sysio@active"
    )
  }

  // ── Chain info ──

  async getInfo(): Promise<WIREChainInfo> {
    return this.run<WIREChainInfo>(["get", "info"], { json: true })
  }

  async getTable(code: string, scope: string, table: string): Promise<string> {
    return this.run(["get", "table", code, scope, table])
  }

  // ── Protocol features ──

  async activateFeature(featureDigest: string): Promise<string> {
    return this.pushAction(
      "sysio",
      "activate",
      JSON.stringify({ feature_digest: featureDigest }),
      "sysio@active"
    )
  }
}

export default Clio
