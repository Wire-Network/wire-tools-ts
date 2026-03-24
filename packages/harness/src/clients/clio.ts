import { execFile } from "child_process"
import { promisify } from "util"
import { log } from "../logger.js"

const execFileAsync = promisify(execFile)

export interface ClioConfig {
  /** Path to clio binary */
  binary: string
  /** nodeop URL (default: http://127.0.0.1:8888) */
  url: string
  /** kiod wallet URL (default: unix socket) */
  walletUrl?: string
}

/**
 * TypeScript wrapper around the `clio` CLI tool.
 * Mirrors the patterns used by cluster_manager.py's Node.publishContract().
 */
export class Clio {
  constructor(private config: ClioConfig) {}

  /** Run a clio command and return parsed JSON (or raw stdout). */
  private async run(args: string[], opts?: { json?: boolean }): Promise<any> {
    const fullArgs = [
      "-u", this.config.url,
      ...(this.config.walletUrl ? ["--wallet-url", this.config.walletUrl] : []),
      ...args,
    ]

    log.debug(`clio ${fullArgs.join(" ")}`)

    try {
      const { stdout, stderr } = await execFileAsync(this.config.binary, fullArgs, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      })
      if (stderr) log.debug(`clio stderr: ${stderr}`)

      if (opts?.json !== false) {
        try {
          return JSON.parse(stdout)
        } catch {
          return stdout.trim()
        }
      }
      return stdout.trim()
    } catch (err: any) {
      log.error(`clio failed: ${err.stderr || err.message}`)
      throw err
    }
  }

  // ── Wallet ──

  async walletCreate(name: string): Promise<string> {
    const result = await this.run(["wallet", "create", "-n", name, "--to-console"], { json: false })
    // Extract the password from stdout
    const match = result.match(/"(PW[A-Za-z0-9]+)"/)
    return match ? match[1] : result
  }

  async walletImportKey(walletName: string, privateKey: string): Promise<void> {
    await this.run(["wallet", "import", "-n", walletName, "--private-key", privateKey], { json: false })
  }

  async walletUnlock(walletName: string, password: string): Promise<void> {
    await this.run(["wallet", "unlock", "-n", walletName, "--password", password], { json: false })
  }

  // ── Account ──

  async createAccount(
    creator: string, name: string, ownerKey: string, activeKey?: string
  ): Promise<any> {
    return this.run([
      "create", "account", creator, name,
      ownerKey, activeKey || ownerKey,
    ])
  }

  async createSystemAccount(name: string, ownerKey: string): Promise<any> {
    return this.createAccount("sysio", name, ownerKey)
  }

  // ── Contract deployment ──

  async setCode(account: string, wasmPath: string): Promise<any> {
    return this.run(["set", "code", account, wasmPath, "-p", `${account}@active`])
  }

  async setAbi(account: string, abiPath: string): Promise<any> {
    return this.run(["set", "abi", account, abiPath, "-p", `${account}@active`])
  }

  async setContract(account: string, contractDir: string, wasmFile: string, abiFile: string): Promise<any> {
    return this.run([
      "set", "contract", account, contractDir,
      wasmFile, abiFile,
      "-p", `${account}@active`,
    ])
  }

  // ── Actions ──

  async pushAction(account: string, action: string, data: string, auth: string): Promise<any> {
    return this.run([
      "push", "action", account, action, data,
      "-p", auth,
    ])
  }

  // ── Privileged ──

  async setPriv(account: string): Promise<any> {
    return this.pushAction("sysio", "setpriv",
      JSON.stringify({ account, is_priv: 1 }),
      "sysio@active"
    )
  }

  // ── Chain info ──

  async getInfo(): Promise<any> {
    return this.run(["get", "info"])
  }

  async getTable(code: string, scope: string, table: string): Promise<any> {
    return this.run(["get", "table", code, scope, table])
  }

  // ── Protocol features ──

  async activateFeature(featureDigest: string): Promise<any> {
    return this.pushAction("sysio", "activate",
      JSON.stringify({ feature_digest: featureDigest }),
      "sysio@active"
    )
  }
}
