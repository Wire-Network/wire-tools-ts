import { execFile } from "child_process"
import { promisify } from "util"
import assert from "node:assert"
import { log } from "../logger.js"
import { asOption, Future } from "@3fv/prelude-ts"
import { flatten, isEmpty, negate } from "lodash"
import { isNotEmpty } from "../util.js"
import {
  Deferred,
  isDefined,
  isNumber,
  isObject,
  isString
} from "@wireio/shared"
import {
  ABISerializableObject,
  AnyAction,
  API,
  BytesType,
  NameType,
  PermissionLevelType,
  SystemContracts
} from "@wireio/sdk-core"
import { match } from "ts-pattern"
import Path from "path"
import Fs from "fs"
import { DEV_K1_PRIVATE_KEY, DEV_K1_PUBLIC_KEY } from "../cluster/constants.js"

const execFileAsync = promisify(execFile)

export interface ClioConfig {
  /**
   * Path to cluster path root
   */
  clusterPath: string

  /** Path to clio binary */
  binary: string
  /** nodeop URL (default: http://127.0.0.1:8888) */
  url: string
  /** kiod wallet URL (default: unix socket) */
  walletUrl?: string
}

export interface ClioRunOptions<UseJson extends boolean = false> {
  json?: UseJson
}

export interface ClioRunOptionsJson<T extends {}> extends ClioRunOptions<true> {
  ctor?: new (data: any) => T
}

/**
 * TypeScript wrapper around the `clio` CLI tool.
 * Mirrors the patterns used by cluster_manager.py's Node.publishContract().
 */
export class Clio {
  private walletPasswordInternal: string = null

  get walletPassword(): string {
    return this.walletPasswordInternal
  }

  set walletPassword(value: string) {
    Fs.writeFileSync(this.walletPasswordFile, value, "utf8")
    this.walletPasswordInternal = value
  }

  constructor(
    readonly config: ClioConfig,
    readonly walletPath: string = Path.join(config.clusterPath, "wallet"),
    readonly walletPasswordFile: string = Path.join(walletPath, "wallet.pw")
  ) {
    if (Fs.existsSync(this.walletPasswordFile)) {
      log.info(`Reading wallet password from ${this.walletPasswordFile}`)
      this.walletPasswordInternal = Fs.readFileSync(
        this.walletPasswordFile,
        "utf8"
      ).trim()
    }
  }

  /** Run a clio command and return parsed JSON (or raw stdout). */
  private async run<T extends {}>(
    args: string[],
    opts: ClioRunOptionsJson<T>
  ): Promise<T>
  private async run(args: string[], opts?: { json?: false }): Promise<string>
  private async run(
    args: string[],
    opts: ClioRunOptions | ClioRunOptionsJson<any> = { json: false }
  ): Promise<any> {
    const fullArgs = [
      "-u",
      this.config.url,
      ...(this.config.walletUrl ? ["--wallet-url", this.config.walletUrl] : []),
      ...args
    ]

    log.info(`clio ${fullArgs.join(" ")}`)

    try {
      const { stdout, stderr } = await execFileAsync(
        this.config.binary,
        fullArgs,
        {
          maxBuffer: Clio.MaxBuffer,
          timeout: Clio.CommandTimeoutMs
        }
      )
      asOption(stderr)
        .filter(isNotEmpty)
        .ifSome(stderr => log.warn(`clio stderr:`, stderr))

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
    return asOption(result.match(/"(PW[A-Za-z0-9]+)"/))
      .map(expMatch => {
        this.walletPassword = expMatch[1]
        return this.walletPassword
      })
      .getOrElse(result)
  }

  async walletImportKey(walletName: string, privateKey: string): Promise<void> {
    await this.run(
      ["wallet", "import", "-n", walletName, "--private-key", privateKey],
      { json: false }
    )
  }

  async walletUnlock(
    walletName: string,
    password: string = this.walletPassword
  ): Promise<void> {
    await this.run(
      ["wallet", "unlock", "-n", walletName, "--password", password],
      { json: false }
    )
  }

  /**
   * Load a wallet file from disk into kiod's memory. Idempotent — kiod's
   * `wallet open` returns a benign "already open" / "could not open"
   * error when the wallet is already loaded; both are swallowed.
   */
  async walletOpen(walletName: string): Promise<void> {
    try {
      await this.run(["wallet", "open", "-n", walletName], { json: false })
    } catch (err: any) {
      const msg = err?.message ?? err?.stderr ?? ""
      if (msg.includes("Already")     ||
          msg.includes("already open") ||
          msg.includes("cannot open"))     // benign "already open" surfaces
      {
        return
      }
      throw err
    }
  }

  /**
   * Open + unlock the wallet in one call. Used by post-bootstrap test
   * code that needs to sign new transactions — the bootstrap process
   * leaves kiod with the wallet closed/locked for security, but the
   * wallet file + password are still on disk and the test can re-open
   * them via this helper.
   */
  async walletOpenAndUnlock(
    walletName: string,
    password: string = this.walletPassword
  ): Promise<void> {
    await this.walletOpen(walletName)
    try {
      await this.walletUnlock(walletName, password)
    } catch (err: any) {
      const msg = err?.message ?? err?.stderr ?? ""
      // Benign — wallet may already be unlocked from a prior call within
      // the same kiod session.
      if (msg.includes("Already unlocked")) return
      throw err
    }
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
    return await this.createAccount("sysio", name, ownerKey)
  }

  // ── Contract deployment ──

  async setCode(account: string, wasmFile: string): Promise<string> {
    return this.run([
      "set",
      "code",
      account,
      wasmFile,
      "-p",
      `${account}@active`
    ])
  }

  async setAbi(account: string, abiFile: string): Promise<string> {
    return this.run(["set", "abi", account, abiFile, "-p", `${account}@active`])
  }

  async setContract(
    account: string,
    contractPath: string,
    wasmFile: string,
    abiFile: string
  ): Promise<string> {
    return this.run([
      "set",
      "contract",
      account,
      contractPath,
      wasmFile,
      abiFile,
      "-p",
      `${account}@active`
    ])
  }

  // ── Actions ──

  /**
   * Push an action to the WIRE chain.
   *
   * `data` is the typed action payload. It is JSON-stringified internally
   * and the response is parsed as `API.v1.SendTransactionResponse`.
   *
   * Per `.claude/rules/strongly-typed-actions.md`, every call MUST specify
   * the matching `SystemContracts.Sysio<Contract><Action>Action` interface
   * as the generic so the data shape is enforced at compile time. The
   * `pushActionRaw` escape hatch below exists for the rare case where a
   * caller genuinely needs to ship pre-stringified JSON (e.g. test
   * fixtures replaying captured calldata); production-style action pushes
   * always go through this typed overload.
   */
  async pushAction<T extends {}>(
    account: string,
    action: string,
    data: T,
    auth: string
  ): Promise<API.v1.SendTransactionResponse> {
    const args = [
      "push",
      "action",
      account,
      action,
      JSON.stringify(data),
      "-p",
      auth,
      "-j"
    ]
    return this.run<API.v1.SendTransactionResponse>(args, { json: true })
  }

  /**
   * **Escape hatch** — push an action with a pre-serialized JSON string
   * payload. Bypasses the strongly-typed generic on `pushAction`. Reserve
   * for the narrow cases where the caller has already produced the
   * JSON-encoded action data (replay fixtures, opaque transcoder paths).
   * For every other call site use `pushAction<SystemContracts.Sysio*Action>`.
   *
   * Named distinctly so a code-review grep can flag every untyped push at
   * a glance.
   */
  async pushActionRaw(
    account: string,
    action: string,
    data: string,
    auth: string
  ): Promise<string> {
    return this.run([
      "push",
      "action",
      account,
      action,
      data,
      "-p",
      auth
    ])
  }

  async pushTransaction(
    ...actionArgs: Clio.IAnyAction[] | Array<Clio.IAnyAction[]>
  ) {
    const actions = flatten(actionArgs),
      body = { actions },
      bodyStr = JSON.stringify(body),
      args = ["push", "transaction", "-j", bodyStr]

    return this.run<API.v1.SendTransactionResponse>(args, { json: true })
  }

  // ── Privileged ──

  async setPriv(account: string): Promise<API.v1.SendTransactionResponse> {
    const result = await this.pushAction<SystemContracts.SysioBiosSetprivAction>(
      "sysio",
      "setpriv",
      { account, is_priv: 1 },
      "sysio@active"
    )
    await this.waitForHeadToAdvance()
    return result
  }

  // ── Transaction confirmation ──

  /**
   * Extract transaction_id from a clio JSON response.
   * Works with pushAction, setContract, etc.
   */
  static getTransId(result: unknown): string | null {
    if (typeof result === "string") {
      try {
        const parsed = JSON.parse(result)
        return parsed?.transaction_id ?? null
      } catch {
        // Try to extract from raw text
        const m = result.match(/"transaction_id"\s*:\s*"([a-f0-9]+)"/)
        return m ? m[1] : null
      }
    }
    if (result && typeof result === "object" && "transaction_id" in result) {
      return (result as { transaction_id: string }).transaction_id
    }
    return null
  }

  // ── HTTP API (direct fetch, bypasses clio CLI) ──

  /** Fetch chain info via /v1/chain/get_info. */
  async getInfo(): Promise<Clio.IGetInfoResponse> {
    const resp = await fetch(`${this.config.url}/v1/chain/get_info`)
    return (await resp.json()) as Clio.IGetInfoResponse
  }

  /** Fetch a block by number or ID via /v1/chain/get_block. */
  async getBlock(
    blockNumOrId: number | string
  ): Promise<Clio.IGetBlockResponse> {
    const resp = await fetch(`${this.config.url}/v1/chain/get_block`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block_num_or_id: blockNumOrId })
    })
    if (!resp.ok) {
      throw new Error(`get_block(${blockNumOrId}) failed: HTTP ${resp.status}`)
    }
    return (await resp.json()) as Clio.IGetBlockResponse
  }

  /** Fetch a transaction trace via /v1/history/get_transaction. */
  async getTransaction(id: string): Promise<Clio.IGetTransactionResponse> {
    // const resp = await fetch(`${this.config.url}/v1/history/get_transaction`, {
    const resp = await fetch(
      `${this.config.url}/v1/trace_api/get_transaction_trace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      }
    )
    return (await match(resp)
      .with({ ok: true }, resp => resp.json())
      .with({ status: 404 }, () => Promise.resolve(null))
      .otherwise(() => {
        throw new Error(`get_transaction(${id}) failed: HTTP ${resp.status}`, {
          cause: resp.statusText
        })
      })) as Promise<Clio.IGetTransactionResponse>
  }

  /** Fetch transaction status via /v1/chain/get_transaction_status. */
  async getTransactionStatus(
    id: string
  ): Promise<Clio.IGetTransactionStatusResponse> {
    const resp = await fetch(
      `${this.config.url}/v1/chain/get_transaction_status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      }
    )

    return (await match(resp)
      .with({ ok: true }, resp => resp.json())
      .with({ status: 404 }, () => Promise.resolve(null))
      .otherwise(() => {
        throw new Error(
          `get_transaction_status(${id}) failed: HTTP ${resp.status}`,
          {
            cause: resp.statusText
          }
        )
      })) as Promise<Clio.IGetTransactionStatusResponse>
  }

  /** Shorthand: get current head block number. */
  async getHead(): Promise<number> {
    const info = await this.getInfo()
    return info.head_block_num
  }

  // ── Waiters ──

  /**
   * Wait for the head block to advance past the current head.
   * Ensures any pending transaction has been included in a block
   * and its effects (like setpriv) are active for subsequent transactions.
   */
  async waitForHeadToAdvance(timeoutMs = Clio.DefaultTimeoutMs): Promise<void> {
    const startBlock = await this.getHead()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await Deferred.delay(Clio.PollIntervalMs)
      try {
        const cur = await this.getHead()
        if (cur > startBlock) return
      } catch {
        /* retry */
      }
    }
    throw new Error(
      `Head block did not advance past ${startBlock} within ${timeoutMs}ms`
    )
  }

  /**
   * Wait until a transaction appears in a block.
   * Mirrors Python TestHarness `getBlockNumByTransId` in queries.py.
   *
   * 1. Polls /v1/history/get_transaction to find the block_num from the trace.
   * 2. Falls back to /v1/chain/get_transaction_status if history is unavailable.
   * 3. Scans blocks forward to verify the transaction is present.
   */
  async waitForTransactionInBlock(
    transId: string,
    timeoutMs = Clio.DefaultTimeoutMs,
    blocksAhead = Clio.BlocksAhead
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs,
      isDeadlinePast = (afterMs: number = 0) => Date.now() + afterMs > deadline

    // Step 1: Poll for the transaction trace to get its block_num
    let refBlockNum: number | null = null
    while (!isDeadlinePast()) {
      try {
        const trace = await this.getTransaction(transId)
        if (isObject(trace) && trace.block_num != null) {
          refBlockNum = trace.block_num
          break
        }
      } catch (err) {
        log.debug("ERROR: get_transaction", err)
      }

      // trace_api may not be available, fall back to transaction status
      // try {
      //   const status = await this.getTransactionStatus(transId)
      //   if (
      //     isString(status?.state) &&
      //     ["IRREVERSIBLE", "IN_BLOCK", "LOCALLY_APPLIED"].includes(status.state)
      //   ) {
      //     break
      //   }
      // } catch (err) {
      //   match(isDeadlinePast(Clio.PollIntervalMs))
      //     .with(false, () => {
      //       log.debug("ERROR: get_transaction_status", err)
      //     })
      //     .otherwise(() => {
      //       log.error("ERROR: get_transaction_status", err)
      //       throw err
      //     })
      // }

      if (!isDeadlinePast(Clio.PollIntervalMs)) {
        await Deferred.delay(Clio.PollIntervalMs)
      }
    }

    // Step 2: Determine scan range
    const headBlock = await this.getHead(),
      startBlock = asOption(refBlockNum)
        .filter(isNumber)
        .filter(num => num > 0)
        .match({
          None: () => headBlock,
          Some: () => refBlockNum
        }),
      endBlock = headBlock + blocksAhead

    // Step 3: Scan blocks in order, returning the first one that contains the tx.
    const scanBlock = async (blockNum: number): Promise<number> => {
      if (blockNum > endBlock || isDeadlinePast()) {
        throw new Error(
          `Transaction ${transId} not found in blocks ${startBlock}–${endBlock} within ${timeoutMs}ms`
        )
      }

      // Wait for the producer to reach this height
      while ((await this.getHead()) < blockNum) {
        if (isDeadlinePast()) {
          throw new Error(
            `Timed out waiting for block ${blockNum} while searching for tx ${transId}`
          )
        }
        await Deferred.delay(Clio.PollIntervalMs)
      }

      try {
        const block = await this.getBlock(blockNum)
        const match = (block.transactions ?? []).find(tx => {
          const txId = typeof tx.trx === "string" ? tx.trx : tx.trx?.id
          return txId === transId
        })
        if (match) {
          log.info(`Transaction ${transId} found in block ${blockNum}`)
          return blockNum
        }
      } catch (err) {
        log.error(`Failed to fetch block ${blockNum}:`, err)
        throw err
      }

      return scanBlock(blockNum + 1)
    }

    return scanBlock(startBlock)
  }

  /**
   * Push an action and wait for it to be included in a block.
   * Uses `-j` flag to get JSON result with `transaction_id`, then waits for block inclusion.
   */
  async pushActionAndWait<T extends {}>(
    account: string,
    action: string,
    data: T,
    auth: string,
    waitTimeoutMs = Clio.DefaultTimeoutMs
  ): Promise<API.v1.SendTransactionResponse> {
    const result = await this.pushAction<T>(account, action, data, auth)

    log.info(`pushActionAndWait result:`, result)

    const txId = asOption(result?.transaction_id)
      .filter(isString)
      .filter(isNotEmpty)
      .getOrThrow(`Result missing transaction_id: ${JSON.stringify(result)}`)

    await this.waitForTransactionInBlock(txId, waitTimeoutMs)
    return result
  }

  /**
   * Deploy a contract and wait for it to be included in a block.
   * Uses `-j` flag to get JSON result with `transaction_id`, then waits for block inclusion.
   */
  async setContractAndWait(
    account: string,
    contractPath: string,
    wasmFile: string,
    abiFile: string,
    waitTimeoutMs = Clio.DefaultTimeoutMs
  ): Promise<Record<string, unknown>> {
    const result = await this.run<Record<string, unknown>>(
      [
        "set",
        "contract",
        account,
        contractPath,
        wasmFile,
        abiFile,
        "-p",
        `${account}@active`,
        "-j"
      ],
      { json: true }
    )
    log.info(
      `setContractAndWait result: ${JSON.stringify(result).slice(0, 200)}`
    )

    // THIS OCCURS WHEN THE CODE IS IDENTICAL TO EXISTING CODE.
    if (isString(result) && result.includes(Clio.NoTransactionSent)) {
      return { transaction_id: "no_transaction_sent" }
    }
    assert(
      typeof result === "object" && result !== null,
      `Expected object result, got ${typeof result}`
    )
    assert(
      "transaction_id" in result,
      `Result missing transaction_id: ${JSON.stringify(result).slice(0, 200)}`
    )
    const txId = result.transaction_id as string
    await this.waitForTransactionInBlock(txId, waitTimeoutMs)
    return result
  }

  // ── Chain info ──

  // async getInfo(): Promise<WIREChainInfo> {
  //   return this.run<WIREChainInfo>(["get", "info"], {
  //     json: true
  //   })
  // }

  async getTable(code: string, scope: string, table: string): Promise<string> {
    return this.run(["get", "table", code, scope, table])
  }

  // ── Protocol features ──

  async activateFeature(
    featureDigest: string
  ): Promise<API.v1.SendTransactionResponse> {
    return this.pushAction<SystemContracts.SysioBiosActivateAction>(
      "sysio",
      "activate",
      { feature_digest: featureDigest },
      "sysio@active"
    )
  }
}

export namespace Clio {
  /** Plain JSON shape returned by /v1/chain/get_info. */
  export interface IGetInfoResponse {
    server_version: string
    chain_id: string
    head_block_num: number
    last_irreversible_block_num: number
    last_irreversible_block_id: string
    head_block_id: string
    head_block_time: string
    head_block_producer: string
  }

  /** Plain JSON shape returned by /v1/chain/get_block. */
  export interface IGetBlockResponse {
    block_num: number
    id: string
    timestamp: string
    producer: string
    transactions: IBlockTransaction[]
  }

  /** A transaction entry within a block response. */
  export interface IBlockTransaction {
    status: string
    trx: { id: string; [key: string]: any } | string
  }

  /** Plain JSON shape returned by /v1/history/get_transaction. */
  export interface IGetTransactionResponse {
    id: string
    block_num: number
    block_time: string
    traces?: any[]
  }

  /** Plain JSON shape returned by /v1/chain/get_transaction_status. */
  export interface IGetTransactionStatusResponse {
    state: string
    head_number: number
    head_id: string
    head_timestamp: string
    irreversible_number: number
    irreversible_id: string
    irreversible_timestamp: string
  }

  export interface IPermissionLevelType {
    actor: string
    permission: string
  }

  /** Action type that may or may not have its data encoded */
  export interface IAnyAction {
    account: string
    name: string
    authorization: IPermissionLevelType[]
    data: string | Uint8Array | ArrayBuffer | Record<string, any> | any
  }

  /** Maximum stdout buffer size for clio subprocess (bytes). */
  export const MaxBuffer = 10 * 1_024 * 1_024

  /** Timeout for a single clio command execution (ms). */
  export const CommandTimeoutMs = 30_000

  /** Default timeout for waiting on transaction inclusion / head advance (ms). */
  export const DefaultTimeoutMs = 30_000

  /** How many blocks ahead of head to scan when searching for a transaction. */
  export const BlocksAhead = 5

  /** Interval between poll attempts when waiting for blocks/transactions (ms). */
  export const PollIntervalMs = 500

  export const NoTransactionSent = "no transaction is sent"
}
