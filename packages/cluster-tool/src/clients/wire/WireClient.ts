import Assert from "node:assert"
import { promises as Fsp } from "node:fs"
import Os from "node:os"
import Path from "node:path"

import { flatten } from "lodash"
import { match } from "ts-pattern"

import {
  getLogger,
  guard as guardAsync,
  isNumber,
  isObject,
  isString,
  NestedError
} from "@wireio/shared"
import {
  API,
  APIClient,
  Asset,
  type PermissionLevelType,
  SysioContracts
} from "@wireio/sdk-core"
import { scaleTimeoutMs, isNotEmpty, retry } from "../../utils/index.js"
import { RecordingFetchProvider } from "./RecordingFetchProvider.js"
import { ClioRunner } from "./clio/ClioRunner.js"
import { WireWallet } from "./WireWallet.js"

const log = getLogger("WireClient")

// The contract registry is exported under the `SysioContracts` namespace; alias
// the value + type locally so the generics below read cleanly (and the §17
// design's top-level names resolve).
const { SysioContractName, SysioContractDefinitions } = SysioContracts
type SysioContractName = SysioContracts.SysioContractName
type SysioContractMapping = SysioContracts.SysioContractMapping

interface ClioTransactionAction<Action extends {}> {
  readonly account: string
  readonly name: string
  readonly authorization: PermissionLevelType[]
  readonly data: Action
}

interface ClioTransactionBody<Action extends {}> {
  readonly actions: ClioTransactionAction<Action>[]
}

interface TransactionFinalityErrorOptions {
  readonly cause?: unknown
}

/** Caller config for the WIRE client (clio binary + node/wallet URLs). */
export interface WireClientConfig {
  readonly clusterPath: string
  readonly binary: string
  readonly nodeopUrl: string
  readonly kiodUrl: string | null
}

/**
 * The merged WIRE transport — folds the old `Clio` (CLI + finality waiters) and
 * `WIREClient` (APIClient table getters) into one client. Transport-only: the
 * AMM / reserve helpers (`splitWireFee`, `swapquote`, `seedReserve`) live in
 * `tools/wire/WireReserveTool`, not here. The typed contract surface +
 * generics live in the companion `namespace WireClient`.
 */
export class WireClient {
  readonly api: APIClient
  readonly wallet: WireWallet
  private readonly runner: ClioRunner

  constructor(readonly config: WireClientConfig) {
    this.runner = new ClioRunner(config)
    this.wallet = new WireWallet(this.runner)
    // The recording provider lands every SDK RPC (table queries, get_info,
    // pushes) in the running step's Report extra — see RecordingFetchProvider.
    this.api = new APIClient({
      provider: new RecordingFetchProvider(config.nodeopUrl)
    })
  }

  // ── Typed contract client (metadata-backed) ──────────────────────────────

  /**
   * Strongly-typed action/table client for `name`. The Proxy validates every
   * member against `SysioContractDefinitions[name]` and rejects unknown names —
   * an ergonomic surface, never an unbounded accept-anything object.
   *
   * @param name - The contract to address.
   * @returns The typed action + table client.
   */
  getSysioContract<Name extends SysioContractName>(
    name: Name
  ): WireClient.SysioContractClient<Name> {
    const def = SysioContractDefinitions[name],
      invokers = new Map<string, WireClient.ActionInvoker<Name, any>>(),
      queries = new Map<string, WireClient.TableQuery<Name, any>>(),
      guard = <T>(
        kind: string,
        known: ReadonlyArray<string>,
        cache: Map<string, T>,
        make: (member: string) => T
      ) =>
        new Proxy({} as Record<string, T>, {
          get: (_target, property) => {
            // symbols + `then` resolve to null (not a function → proxy stays
            // non-thenable); null over undefined per the prefer-null rule.
            if (typeof property === "symbol" || property === "then") return null
            const member = String(property)
            Assert.ok(
              known.includes(member),
              `Unknown sysio.${name} ${kind}: ${member}`
            )
            return (
              cache.get(member) ?? cache.set(member, make(member)).get(member)!
            )
          }
        })
    return {
      actions: guard("action", def.actions, invokers, member =>
        this.actionInvoker(def.name, def.account, member)
      ),
      tables: guard("table", def.tables, queries, member =>
        this.tableQuery(def.account, member)
      )
    } as unknown as WireClient.SysioContractClient<Name>
  }

  private actionInvoker(
    contract: SysioContractName,
    account: string,
    action: string
  ): WireClient.ActionInvoker<any, any> {
    const authorize = (
      options?: WireClient.InvocationOptions
    ): PermissionLevelType[] =>
      options?.authorization ?? [{ actor: account, permission: "active" }]
    return {
      prepare: (data, options) => ({
        contract,
        account,
        name: action,
        authorization: authorize(options),
        data
      }),
      invoke: (data, options) =>
        this.invoke(account, action, data, authorize(options), options),
      invokeOnce: (data, options) =>
        this.invokeOnce(account, action, data, authorize(options), options),
      invokeViaFile: (data, options) =>
        this.invokeViaFile(account, action, data, authorize(options), options),
      invokeViaFileOnce: (data, options) =>
        this.invokeViaFileOnce(
          account,
          action,
          data,
          authorize(options),
          options
        )
    }
  }

  private tableQuery(
    account: string,
    table: string
  ): WireClient.TableQuery<any, any> {
    return {
      query: (args = {}) =>
        this.getTableRows({
          account,
          scope: args.scope ?? account,
          table,
          limit: args.limit,
          lowerBound: args.lowerBound,
          upperBound: args.upperBound
        })
    }
  }

  // ── Actions / transactions ───────────────────────────────────────────────

  /** Single typed action; waits for finality by default (`skipWait` to fire-and-forget). */
  async invoke<Action extends {}>(
    account: string,
    action: string,
    data: Action,
    authorization: PermissionLevelType[],
    options: WireClient.InvocationOptions = {}
  ): Promise<API.v1.SendTransactionResponse> {
    const [{ actor, permission }] = authorization,
      auth = `${actor}@${permission}`,
      label = `${account}::${action}`,
      send = () =>
        this.runner.run<API.v1.SendTransactionResponse>(
          [
            "push",
            "action",
            account,
            action,
            JSON.stringify(data),
            "-p",
            auth,
            "-j"
          ],
          { json: true }
        )
    if (options.skipWait) return send()
    return this.withFinality(label, send, options.finality)
  }

  /**
   * Invoke a single action without transport or finality resends.
   *
   * The owning orchestration Step must reconcile an ambiguous outcome before
   * deciding whether the action may be attempted again.
   *
   * @param account - Contract account receiving the action.
   * @param action - Contract action name.
   * @param data - Typed action payload.
   * @param authorization - Permission levels authorizing the action.
   * @param options - Invocation finality and authorization options.
   * @returns The single transaction submission response.
   */
  async invokeOnce<Action extends {}>(
    account: string,
    action: string,
    data: Action,
    authorization: PermissionLevelType[],
    options: WireClient.InvocationOptions = {}
  ): Promise<API.v1.SendTransactionResponse> {
    const [{ actor, permission }] = authorization,
      auth = `${actor}@${permission}`,
      label = `${account}::${action}`,
      send = () =>
        this.runner.runOnce<API.v1.SendTransactionResponse>(
          [
            "push",
            "action",
            account,
            action,
            JSON.stringify(data),
            "-p",
            auth,
            "-j"
          ],
          { json: true }
        )
    if (options.skipWait) return send()
    return this.withFinalityOnce(label, send, options.finality)
  }

  /** Multi-action tx; variadic + flatten. Waits by default. */
  async invokeTransaction(
    ...payloads: Array<
      WireClient.ActionPayload<any, any> | WireClient.ActionPayload<any, any>[]
    >
  ): Promise<API.v1.SendTransactionResponse> {
    const actions = flatten(payloads),
      label = actions.map(a => `${a.account}::${a.name}`).join(","),
      send = () =>
        this.runner.run<API.v1.SendTransactionResponse>(
          ["push", "transaction", "-j", JSON.stringify({ actions })],
          { json: true }
        )
    return this.withFinality(label, send)
  }

  /**
   * Single action pushed via a temp transaction file — for large `data` (e.g.
   * `sysio.roa::setsyscode`'s wasm hex) that would exceed the command-line arg
   * limit (E2BIG). Waits for finality by default.
   */
  async invokeViaFile<Action extends {}>(
    account: string,
    action: string,
    data: Action,
    authorization: PermissionLevelType[],
    options: WireClient.InvocationOptions = {}
  ): Promise<API.v1.SendTransactionResponse> {
    const label = `${account}::${action} (file)`,
      body = { actions: [{ account, name: action, authorization, data }] },
      send = () =>
        this.sendViaFile(body, file =>
          this.runner.run<API.v1.SendTransactionResponse>(
            ["push", "transaction", "-j", file],
            { json: true }
          )
        )
    if (options.skipWait) return send()
    return this.withFinality(label, send, options.finality)
  }

  /**
   * Invoke through a temporary transaction file without transport or finality
   * resends. The owning Step must reconcile any ambiguous finality outcome.
   *
   * @param account - Contract account receiving the action.
   * @param action - Contract action name.
   * @param data - Typed action payload written to the temporary file.
   * @param authorization - Permission levels authorizing the action.
   * @param options - Invocation finality and authorization options.
   * @returns The single transaction submission response.
   */
  async invokeViaFileOnce<Action extends {}>(
    account: string,
    action: string,
    data: Action,
    authorization: PermissionLevelType[],
    options: WireClient.InvocationOptions = {}
  ): Promise<API.v1.SendTransactionResponse> {
    const label = `${account}::${action} (file)`,
      body = { actions: [{ account, name: action, authorization, data }] },
      send = () =>
        this.sendViaFile(body, file =>
          this.runner.runOnce<API.v1.SendTransactionResponse>(
            ["push", "transaction", "-j", file],
            { json: true }
          )
        )
    if (options.skipWait) return send()
    return this.withFinalityOnce(label, send, options.finality)
  }

  private async sendViaFile<Action extends {}>(
    body: ClioTransactionBody<Action>,
    send: (file: string) => Promise<API.v1.SendTransactionResponse>
  ): Promise<API.v1.SendTransactionResponse> {
    const directory = await Fsp.mkdtemp(
        Path.join(Os.tmpdir(), "wire-clio-transaction-")
      ),
      file = Path.join(directory, "transaction.json")
    try {
      await Fsp.writeFile(file, JSON.stringify(body), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      })
      return await send(file)
    } finally {
      await guardAsync(
        () => Fsp.rm(directory, { recursive: true, force: true }),
        error =>
          log.warn(
            `Unable to remove temporary clio transaction directory ${directory}: ${errorText(error)}`
          )
      )
    }
  }

  /** Deploy + set ABI, waits for finality; idempotent redeploy is a settled no-op. */
  async setContract(
    account: string,
    contractPath: string,
    wasmFile: string,
    abiFile: string,
    options: WireClient.InvocationOptions = {}
  ): Promise<Record<string, unknown>> {
    const label = `setContract ${account}`,
      send = async () => {
        const result = await this.runner.run<Record<string, unknown>>(
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
        // Identical code → settled no-op.
        if (isString(result) && result.includes(WireClient.NoTransactionSent))
          return {
            transaction_id: WireClient.NoTransactionSentTransactionId
          } as Record<string, unknown>
        return result
      }
    return this.withFinality(label, send as any, options.finality) as Promise<
      Record<string, unknown>
    >
  }

  /** Activate a protocol feature (sysio.bios::activate). */
  activateFeature(
    featureDigest: string
  ): Promise<API.v1.SendTransactionResponse> {
    return this.invoke("sysio", "activate", { feature_digest: featureDigest }, [
      { actor: "sysio", permission: "active" }
    ])
  }

  /** Mark `account` privileged (sysio.bios::setpriv), waiting for irreversibility. */
  setPriv(account: string): Promise<API.v1.SendTransactionResponse> {
    return this.invoke("sysio", "setpriv", { account, is_priv: 1 }, [
      { actor: "sysio", permission: "active" }
    ])
  }

  /**
   * Create an account with the given owner/active keys (`clio create account`),
   * waiting for finality. `creator`'s key must be in the wallet.
   */
  createAccount(
    creator: string,
    name: string,
    ownerKey: string,
    activeKey: string
  ): Promise<API.v1.SendTransactionResponse> {
    return this.withFinality(`create account ${name}`, () =>
      this.runner.run<API.v1.SendTransactionResponse>(
        ["create", "account", creator, name, ownerKey, activeKey, "-j"],
        { json: true }
      )
    )
  }

  /** The chain's supported protocol features (POST /v1/producer/get_supported_protocol_features). */
  async getSupportedProtocolFeatures(): Promise<WireClient.ProtocolFeature[]> {
    const response = await fetch(
      `${this.config.nodeopUrl}/v1/producer/get_supported_protocol_features`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      }
    )
    Assert.ok(
      response.ok,
      `get_supported_protocol_features failed: ${response.statusText}`
    )
    const features = await response.json()
    return Array.isArray(features)
      ? (features as WireClient.ProtocolFeature[])
      : []
  }

  // ── RPC getters (v6 `.value` unwrap retained) ────────────────────────────

  /** GET /v1/chain/get_info. */
  getInfo(): Promise<WireClient.GetInfoResponse> {
    return this.api.v1.chain.get_info() as unknown as Promise<WireClient.GetInfoResponse>
  }

  /**
   * Raw table read (ESCAPE HATCH) — unwraps v6 KV `{ key, value }` rows to flat
   * rows. Prefer `getSysioContract(name).tables.<table>.query(...)` for any
   * `sysio.*` contract table; see `prefer-typed-contract-table-accessors.md`.
   */
  async getTableRows<Row = unknown>(
    query: WireClient.TableRowsQuery
  ): Promise<WireClient.TableQueryResult<Row>> {
    const result: any = await this.api.v1.chain.get_table_rows({
      code: query.account,
      scope: query.scope,
      table: query.table,
      json: true,
      limit: query.limit ?? WireClient.DefaultRowLimit,
      // omit bounds when null (conditional spread — no undefined)
      ...(query.lowerBound != null ? { lower_bound: query.lowerBound } : {}),
      ...(query.upperBound != null ? { upper_bound: query.upperBound } : {})
    } as any)
    const rows = (result.rows ?? []).map((row: any) =>
        row != null && typeof row === "object" && "value" in row
          ? row.value
          : row
      ),
      nextKey =
        result.next_key == null || result.next_key === ""
          ? null
          : String(result.next_key)
    return {
      rows: rows as Row[],
      more: Boolean(result.more),
      nextKey
    }
  }

  /** Real WIRE token balance (raw 9-decimal base units), or 0n when no row. */
  async getWireBalance(account: string): Promise<bigint> {
    const rows = (await this.api.v1.chain.get_currency_balance(
      "sysio.token",
      account,
      "WIRE"
    )) as unknown as Asset[]
    if (!rows || rows.length === 0) return 0n
    const [amount] = rows[0].toString().split(" ")
    const [whole, frac = ""] = amount.split(".")
    return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"))
  }

  // Convenience getters delegate to the typed contract-table accessor
  // (prefer-typed-contract-table-accessors.md) — never a raw getTableRows.
  getOperators() {
    return this.getSysioContract(
      SysioContractName.opreg
    ).tables.operators.query()
  }
  getWithdrawQueue() {
    return this.getSysioContract(
      SysioContractName.opreg
    ).tables.wtdwqueue.query()
  }
  getEpochState() {
    return this.getSysioContract(
      SysioContractName.epoch
    ).tables.epochstate.query()
  }
  getEpochConfig() {
    return this.getSysioContract(
      SysioContractName.epoch
    ).tables.epochcfg.query()
  }
  getChains() {
    return this.getSysioContract(SysioContractName.chains).tables.chains.query()
  }
  getMessages() {
    return this.getSysioContract(
      SysioContractName.msgch
    ).tables.messages.query()
  }
  getEnvelopes() {
    return this.getSysioContract(
      SysioContractName.msgch
    ).tables.envelopes.query()
  }
  getAttestations() {
    return this.getSysioContract(
      SysioContractName.msgch
    ).tables.attestations.query()
  }
  getOutboundEnvelopes() {
    return this.getSysioContract(
      SysioContractName.msgch
    ).tables.outenvelopes.query()
  }
  getUwRequests() {
    return this.getSysioContract(SysioContractName.uwrit).tables.uwreqs.query()
  }
  getLocks() {
    return this.getSysioContract(SysioContractName.uwrit).tables.locks.query()
  }

  /** Raw `clio get table` (positional account+table, scope via -S). */
  getTable(code: string, scope: string, table: string): Promise<string> {
    return this.runner.run(["get", "table", code, table, "-S", scope])
  }

  // ── Finality / blocks (ported from Clio) ─────────────────────────────────

  /** Current head block number. */
  async getHead(): Promise<number> {
    return (await this.getInfo()).head_block_num
  }

  /** Fetch a block by number/id via /v1/chain/get_block. */
  async getBlock(
    blockNumOrId: number | string
  ): Promise<WireClient.GetBlockResponse> {
    const resp = await fetch(`${this.config.nodeopUrl}/v1/chain/get_block`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block_num_or_id: blockNumOrId })
    })
    if (!resp.ok)
      throw new Error(`get_block(${blockNumOrId}) failed: HTTP ${resp.status}`)
    return (await resp.json()) as WireClient.GetBlockResponse
  }

  /** Fetch a transaction trace via /v1/trace_api/get_transaction_trace. */
  async getTransaction(
    id: string
  ): Promise<WireClient.GetTransactionResponse | null> {
    const resp = await fetch(
      `${this.config.nodeopUrl}/v1/trace_api/get_transaction_trace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      }
    )
    return (await match(resp)
      .with({ ok: true }, r => r.json())
      .with({ status: 404 }, () => Promise.resolve(null))
      .otherwise(() => {
        throw new Error(`get_transaction(${id}) failed: HTTP ${resp.status}`)
      })) as WireClient.GetTransactionResponse | null
  }

  /** Wait for head to advance past the current head. */
  async waitForHeadToAdvance(
    timeoutMs = scaleTimeoutMs(WireClient.DefaultTimeoutMs)
  ): Promise<void> {
    const startBlock = await this.getHead(),
      deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await delay(WireClient.PollIntervalMs)
      try {
        if ((await this.getHead()) > startBlock) return
      } catch (err) {
        log.debug(`waitForHeadToAdvance poll error: ${errorText(err)}`)
      }
    }
    throw new Error(
      `Head block did not advance past ${startBlock} within ${timeoutMs}ms`
    )
  }

  /** Push (via `send`), wait to `finality` (default irreversible), re-push on fork-out. */
  private withFinality<T extends { transaction_id?: string }>(
    label: string,
    send: () => Promise<T>,
    finality: WireClient.FinalityType = WireClient.DefaultFinality
  ): Promise<T> {
    return retry(() => this.sendAndAssertFinality(label, send, finality), {
      maxAttempts: WireClient.FinalityMaxAttempts,
      delayMs: WireClient.FinalityRetryDelayMs,
      label
    })
  }

  /** Push once and observe finality once without resending the transaction. */
  private withFinalityOnce<T extends { transaction_id?: string }>(
    label: string,
    send: () => Promise<T>,
    finality: WireClient.FinalityType = WireClient.DefaultFinality
  ): Promise<T> {
    return this.sendAndAssertFinality(label, send, finality)
  }

  private async sendAndAssertFinality<T extends { transaction_id?: string }>(
    label: string,
    send: () => Promise<T>,
    finality: WireClient.FinalityType
  ): Promise<T> {
    const result = await send(),
      transactionId = WireClient.getTransactionId(result)
    if (isString(transactionId) && isNotEmpty(transactionId))
      await this.assertFinality(
        transactionId,
        label,
        finality,
        scaleTimeoutMs(WireClient.DefaultTimeoutMs)
      )
    return result
  }

  /** Wait for `transactionId` to reach `finality`, throwing if forked out (drives re-push). */
  private async assertFinality(
    transactionId: string,
    label: string,
    finality: WireClient.FinalityType,
    timeoutMs: number
  ): Promise<void> {
    let blockNum: number | null = null
    try {
      blockNum = await this.waitForTransactionInBlock(transactionId, timeoutMs)
      if (
        finality === WireClient.FinalityType.irreversible &&
        !(await this.waitForTransactionIrreversible(
          transactionId,
          blockNum,
          timeoutMs
        ))
      )
        throw new Error("transaction did not reach irreversible finality")
    } catch (error) {
      throw new WireClient.TransactionFinalityError(
        label,
        transactionId,
        blockNum,
        { cause: error }
      )
    }
  }

  /**
   * Prove that `transactionId` is present in a canonical block at or below
   * LIB. A known observed block is checked even when trace lookup is absent.
   *
   * @param transactionId - Exact submitted transaction id to prove.
   * @param observedBlockNum - Block observed before finality became ambiguous.
   * @returns Whether the transaction is present in a canonical irreversible block.
   */
  async isTransactionIrreversible(
    transactionId: string,
    observedBlockNum: number = null
  ): Promise<boolean> {
    const locatedBlockNum = await this.locateTransactionBlock(transactionId),
      candidates = [
        ...new Set(
          [locatedBlockNum, observedBlockNum].filter(
            (blockNum): blockNum is number => blockNum != null
          )
        )
      ],
      lib = (await this.getInfo()).last_irreversible_block_num,
      blocks = await Promise.all(
        candidates
          .filter(blockNum => blockNum <= lib)
          .map(blockNum => this.getBlock(blockNum))
      )
    return blocks.some(block =>
      WireClient.blockContainsTransaction(block, transactionId)
    )
  }

  /** Poll until a tx appears in a block; returns its block number. */
  async waitForTransactionInBlock(
    transactionId: string,
    timeoutMs = scaleTimeoutMs(WireClient.DefaultTimeoutMs),
    blocksAhead = WireClient.BlocksAhead
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs,
      isDeadlinePast = (afterMs = 0) => Date.now() + afterMs > deadline
    let refBlockNum: number | null = null
    while (!isDeadlinePast()) {
      try {
        const trace = await this.getTransaction(transactionId)
        if (isObject(trace) && trace.block_num != null) {
          refBlockNum = trace.block_num
          break
        }
      } catch (err) {
        log.debug(`get_transaction error: ${errorText(err)}`)
      }
      if (!isDeadlinePast(WireClient.PollIntervalMs))
        await delay(WireClient.PollIntervalMs)
    }
    const headBlock = await this.getHead(),
      startBlock =
        refBlockNum != null && refBlockNum > 0 ? refBlockNum : headBlock,
      endBlock = headBlock + blocksAhead
    const scanBlock = async (blockNum: number): Promise<number> => {
      if (blockNum > endBlock || isDeadlinePast())
        throw new Error(
          `Transaction ${transactionId} not found in blocks ${startBlock}–${endBlock} within ${timeoutMs}ms`
        )
      while ((await this.getHead()) < blockNum) {
        if (isDeadlinePast())
          throw new Error(
            `Timed out waiting for block ${blockNum} while searching for tx ${transactionId}`
          )
        await delay(WireClient.PollIntervalMs)
      }
      const block = await this.getBlock(blockNum)
      if (WireClient.blockContainsTransaction(block, transactionId)) {
        log.info(`Transaction ${transactionId} found in block ${blockNum}`)
        return blockNum
      }
      return scanBlock(blockNum + 1)
    }
    return scanBlock(startBlock)
  }

  /** Resolve the block a tx currently sits at, or null (forked out / not applied). */
  private async locateTransactionBlock(
    transactionId: string
  ): Promise<number | null> {
    const trace = await this.getTransaction(transactionId)
    return isObject(trace) && isNumber(trace.block_num) && trace.block_num > 0
      ? trace.block_num
      : null
  }

  /** Wait until a tx is in an IRREVERSIBLE block; false if forked out (caller re-pushes). */
  async waitForTransactionIrreversible(
    transactionId: string,
    blockNum: number,
    timeoutMs = scaleTimeoutMs(WireClient.DefaultTimeoutMs)
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let height = blockNum
    while (Date.now() < deadline) {
      try {
        const lib = (await this.getInfo()).last_irreversible_block_num
        if (lib >= height) {
          const block = await this.getBlock(height)
          if (WireClient.blockContainsTransaction(block, transactionId))
            return true
          const relocated = await this.locateTransactionBlock(transactionId)
          if (relocated === null) return false
          height = relocated
        }
      } catch (err) {
        log.debug(
          `waitForTransactionIrreversible(${transactionId}) poll error: ${errorText(err)}`
        )
      }
      await delay(WireClient.PollIntervalMs)
    }
    return false
  }
}

/** Sleep helper local to the finality waiters. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
/** Stringify an unknown error for a log line. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export namespace WireClient {
  // ── Contract-client typing (keyed by contract Name + member) ──
  export interface InvocationOptions {
    authorization?: PermissionLevelType[]
    skipWait?: boolean
    finality?: FinalityType
  }
  /** Finality failure retaining transaction identity for Step reconciliation. */
  export class TransactionFinalityError extends NestedError {
    constructor(
      readonly label: string,
      readonly transactionId: string,
      readonly observedBlockNum: number,
      options: TransactionFinalityErrorOptions = {}
    ) {
      super(
        `${label}: transaction ${transactionId} did not reach irreversible finality`,
        {
          cause: options.cause,
          context: { label, transactionId, observedBlockNum }
        }
      )
      this.name = "TransactionFinalityError"
    }
  }
  export type ContractOf<Name extends SysioContractName> =
    SysioContractMapping[Name]
  export type ActionName<Name extends SysioContractName> = Extract<
    keyof ContractOf<Name>["actions"],
    string
  >
  export type TableName<Name extends SysioContractName> = Extract<
    keyof ContractOf<Name>["tables"],
    string
  >
  export type ActionData<
    Name extends SysioContractName,
    Action extends ActionName<Name>
  > = ContractOf<Name>["actions"][Action]
  export type TableRow<
    Name extends SysioContractName,
    Table extends TableName<Name>
  > = ContractOf<Name>["tables"][Table]

  export interface ActionPayload<
    Name extends SysioContractName,
    Action extends ActionName<Name>
  > {
    readonly contract: Name
    readonly account: string
    readonly name: Action
    readonly authorization: ReadonlyArray<PermissionLevelType>
    readonly data: ActionData<Name, Action>
  }
  export interface ActionInvoker<
    Name extends SysioContractName,
    Action extends ActionName<Name>
  > {
    prepare(
      data: ActionData<Name, Action>,
      options?: InvocationOptions
    ): ActionPayload<Name, Action>
    invoke(
      data: ActionData<Name, Action>,
      options?: InvocationOptions
    ): Promise<API.v1.SendTransactionResponse>
    /**
     * Invoke without transport or finality resends. The owning Step must
     * reconcile ambiguous outcomes.
     */
    invokeOnce(
      data: ActionData<Name, Action>,
      options?: InvocationOptions
    ): Promise<API.v1.SendTransactionResponse>
    /**
     * Invoke through a temporary transaction file so bulk data never enters a
     * process argument, debug log, or report extra.
     */
    invokeViaFile(
      data: ActionData<Name, Action>,
      options?: InvocationOptions
    ): Promise<API.v1.SendTransactionResponse>
    /**
     * Invoke through a temporary transaction file without transport or
     * finality resends. The owning Step must reconcile ambiguous outcomes.
     */
    invokeViaFileOnce(
      data: ActionData<Name, Action>,
      options?: InvocationOptions
    ): Promise<API.v1.SendTransactionResponse>
  }
  export interface TableQueryArgs {
    scope?: string
    limit?: number
    lowerBound?: string | null
    upperBound?: string | null
  }
  export interface TableQueryResult<Row> {
    rows: Row[]
    more: boolean
    /** Lower bound for the next page, or `null` when the result is complete. */
    nextKey: string
  }
  export interface TableQuery<
    Name extends SysioContractName,
    Table extends TableName<Name>
  > {
    query(
      args?: TableQueryArgs
    ): Promise<TableQueryResult<TableRow<Name, Table>>>
  }
  export type SysioContractClient<Name extends SysioContractName> = {
    readonly actions: {
      readonly [Action in ActionName<Name>]: ActionInvoker<Name, Action>
    }
    readonly tables: {
      readonly [Table in TableName<Name>]: TableQuery<Name, Table>
    }
  }

  // ── Finality ──
  export enum FinalityType {
    speculative = "speculative",
    head = "head",
    irreversible = "irreversible"
  }
  export const DefaultFinality = FinalityType.irreversible
  export const FinalityMaxAttempts = 3
  export const FinalityRetryDelayMs = 1_000
  export const DefaultTimeoutMs = 60_000
  export const PollIntervalMs = 500
  export const BlocksAhead = 5
  export const NoTransactionSent = "no transaction is sent"
  export const NoTransactionSentTransactionId = "no_transaction_sent"

  // ── Table getters config ──
  // (contract accounts + table names come from SysioContractName /
  // getSysioContract(name).tables — no dupe enums here.)
  export const DefaultRowLimit = 100

  /**
   * Raw table-read query. ESCAPE HATCH — prefer
   * `getSysioContract(name).tables.<table>.query(...)`; see
   * `prefer-typed-contract-table-accessors.md`.
   */
  export interface TableRowsQuery {
    account: string
    scope: string
    table: string
    limit?: number
    lowerBound?: string | null
    upperBound?: string | null
  }

  // ── Response shapes ──
  export interface GetInfoResponse {
    server_version: string
    chain_id: string
    head_block_num: number
    last_irreversible_block_num: number
    head_block_time: string
    head_block_id: string
    head_block_producer: string
  }
  /** A single protocol-feature specification entry. */
  export interface ProtocolFeatureSpecification {
    name: string
    value: string
  }
  /** One entry from get_supported_protocol_features. */
  export interface ProtocolFeature {
    feature_digest: string
    specification?: ProtocolFeatureSpecification[]
  }
  /** A reference to a transaction by id. */
  export interface TransactionReference {
    id: string
  }
  /** One transaction entry in a block. */
  export interface BlockTransaction {
    status: string
    trx: TransactionReference | string
  }
  export interface GetBlockResponse {
    block_num: number
    id: string
    transactions: BlockTransaction[]
  }
  export interface GetTransactionResponse {
    id: string
    block_num: number
    block_time: string
  }

  /** Extract `transaction_id` from a clio JSON response. */
  export function getTransactionId(result: unknown): string | null {
    if (typeof result === "string") {
      try {
        return JSON.parse(result)?.transaction_id ?? null
      } catch {
        const m = result.match(/"transaction_id"\s*:\s*"([a-f0-9]+)"/)
        return m ? m[1] : null
      }
    }
    if (result && typeof result === "object" && "transaction_id" in result)
      return (result as { transaction_id: string }).transaction_id
    return null
  }

  /** True if the block's transaction list contains `transactionId`. */
  export function blockContainsTransaction(
    block: GetBlockResponse,
    transactionId: string
  ): boolean {
    return (block.transactions ?? []).some(
      transaction =>
        (typeof transaction.trx === "string"
          ? transaction.trx
          : transaction.trx?.id) === transactionId
    )
  }
}
