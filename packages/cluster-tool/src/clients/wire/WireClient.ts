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
  Name,
  type PermissionLevelType,
  SysioContracts
} from "@wireio/sdk-core"
import { ProtocolTiming } from "../../Constants.js"
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
  /**
   * Finalizers in the cluster's genesis policy — the producer nodes, which is
   * exactly the set `ConsensusSteps` builds the policy from.
   *
   * Sizes the irreversibility budget via
   * {@link ProtocolTiming.irreversibilityBudgetMs}: a Savanna quorum round
   * costs more wall clock as the finalizer set grows, so a budget that ignores
   * topology is right for a 1-node dev cluster and wrong for a 21-producer one.
   * Omitted (or 0) falls back to the single-finalizer floor.
   */
  readonly finalizerCount?: number
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
    } as WireClient.SysioContractClient<Name>
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
  async invoke<Action extends object>(
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
            "-j",
            ...this.expirationArgs
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
            "-j",
            ...this.expirationArgs
          ],
          { json: true }
        )
    if (options.skipWait) return send()
    return this.withFinalityOnce(label, send, options.finality)
  }

  /**
   * clio's `--expiration` args for every pushed transaction.
   *
   * clio defaults to 30s, which is the window between SIGNING and INCLUSION —
   * not execution. On a large cluster a push lands on whichever node the client
   * dials, and that node must relay it to whichever of the N producers is
   * currently producing. When block propagation degrades the tx can expire
   * unincluded, surfacing as `expired_tx_exception` rather than anything that
   * names the real cause. See {@link WireClient.TransactionExpirationSec}.
   */
  private get expirationArgs(): string[] {
    return ["--expiration", String(WireClient.TransactionExpirationSec)]
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
          [
            "push",
            "transaction",
            "-j",
            JSON.stringify({ actions }),
            ...this.expirationArgs
          ],
          { json: true }
        )
    return this.withFinality(label, send)
  }

  /**
   * Single action pushed via a temp transaction file — for large `data` (e.g.
   * `sysio.roa::setsyscode`'s wasm hex) that would exceed the command-line arg
   * limit (E2BIG). Waits for finality by default.
   */
  async invokeViaFile<Action extends object>(
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
            ["push", "transaction", "-j", file, ...this.expirationArgs],
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
            ["push", "transaction", "-j", file, ...this.expirationArgs],
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

  /**
   * GET /v1/chain/get_info, projected onto plain JSON scalars.
   *
   * sdk-core answers with its rich `Struct` shape (`Checksum256`, `UInt32`,
   * `TimePoint`, `Name`), so every field is CONVERTED here rather than
   * asserted: the harness compares chain ids as strings and does arithmetic on
   * block numbers, and an assertion would have handed those call sites wrapper
   * objects that merely LOOK right through template interpolation.
   */
  async getInfo(): Promise<WireClient.GetInfoResponse> {
    const info = await this.api.v1.chain.get_info()
    return {
      server_version: info.server_version,
      chain_id: String(info.chain_id),
      head_block_num: Number(info.head_block_num),
      last_irreversible_block_num: Number(info.last_irreversible_block_num),
      head_block_time: String(info.head_block_time),
      head_block_id: String(info.head_block_id),
      head_block_producer: String(info.head_block_producer)
    }
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
    )) as Asset[]
    if (!rows || rows.length === 0) return 0n
    const [amount] = rows[0].toString().split(" ")
    const [whole, frac = ""] = amount.split(".")
    return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"))
  }

  /**
   * Pull `account`'s claimable WIRE from `sysio.reserv` — swap-to-WIRE payouts and swap-from-WIRE
   * refunds.
   *
   * Those settlement paths credit a balance instead of transferring: `sysio.token::transfer`
   * notifies its recipient, and the chain runs notified receivers with no exception isolation, so
   * a pushed payout let the recipient abort the enclosing transaction — which for `refundwire`
   * meant halting the epoch drain chain-wide. The claim carries the claimant's own authority, so a
   * hostile recipient can only block itself.
   *
   * Throws when nothing is owed; check {@link getWireClaimable} first if that is not a failure.
   */
  async claimWire(account: string, permission = "active") {
    return this.invoke("sysio.reserv", "claimwire", { account }, [{ actor: account, permission }])
  }

  /**
   * WIRE owed to `account` but not yet claimed, or 0n when there is no row.
   *
   * Raw `getTableRows` rather than the typed contract-table accessor
   * (`prefer-typed-contract-table-accessors.md`) because `wireclaims` is new and does not reach
   * the typed surface until `@wireio/sdk-core` publishes the regenerated `SysioContractTypes`.
   * Switch to `getSysioContract(SysioContractName.reserv).tables.wireclaims.query()` once that
   * version is released and this package's dependency is bumped.
   */
  async getWireClaimable(account: string): Promise<bigint> {
    return this.claimableBalance("sysio.reserv", "wireclaims", "account", account)
  }

  /**
   * One claimable row's balance, or 0n when the account has none.
   *
   * Reads with a LOWER bound only. The node's upper bound is EXCLUSIVE
   * (`chain_plugin.cpp`: `if (has_upper && kv >= ub_sv) break;` — the exclusive increment at the
   * `find` branch does not apply here), so passing lower == upper describes an empty range and
   * returns nothing however long you poll.
   *
   * Keys encode big-endian (`be_key_codec`), so iteration is numeric order and the first row
   * at-or-after the key belongs to this account IF it has one. When it does not, the walk yields
   * the NEXT account's row — which is why the identity check is load-bearing here, not defensive:
   * without it an unpaid account reads back a stranger's balance.
   */
  private async claimableBalance(
    contract: string,
    table: string,
    keyField: string,
    account: string
  ): Promise<bigint> {
    const { rows } = await this.getTableRows<WireClient.ClaimableRow>({
      account: contract,
      scope: contract,
      table,
      lowerBound: WireClient.nameKeyBound(keyField, account),
      limit: 1
    })
    const [row] = rows
    if (row == null) return 0n
    // wireclaims names the row's account `account`; payclaims names it `account_name`.
    const { account: rowAccount, account_name: rowAccountName, balance } = row
    return (rowAccount ?? rowAccountName) === account ? BigInt(balance) : 0n
  }

  /**
   * Pull `account`'s credited epoch pay from `sysio.system` — a producer, standby or
   * batch-operator share. `payepoch` credits rather than transfers for the same reason as above:
   * it runs inline from `sysio.epoch::advance`, which must never abort.
   *
   * The T5 category buckets (`sysio.ops`, `sysio.gov`) are NOT claimable: `payepoch` transfers to
   * them directly, because ROA zeroes net/cpu for every `sysio`-prefixed account and neither
   * carries a contract that could emit the claim inline, so neither could ever authorize one.
   */
  async claimPay(account: string, permission = "active") {
    return this.invoke("sysio", "claimpay", { account_name: account }, [
      { actor: account, permission }
    ])
  }

  /** Epoch pay owed to `account` but not yet claimed, or 0n when there is no row. Raw table read
   *  for the same reason as {@link getWireClaimable}. */
  async getPayClaimable(account: string): Promise<bigint> {
    return this.claimableBalance("sysio", "payclaims", "account_name", account)
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
  ): Promise<WireClient.GetTransactionResponse> {
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

  /**
   * Push (via `send`), then wait for `finality`.
   *
   * **A re-push happens ONLY when the transaction is PROVEN un-appliable.**
   * That is the whole point of this method's shape, and it is structural — a
   * `pending`/unresolved wait has no code path back to `send()`, rather than
   * being talked out of one by a predicate.
   *
   * The previous form wrapped `send()` AND the wait in one `retry`, so ANY
   * wait failure re-invoked `send()`. On 2026-08-04 that re-pushed an
   * already-applied `sysio.acct` creation twice: the wait had merely timed out
   * (LIB was lagging at 21 finalizers), the account existed the whole time, and
   * both re-pushes bounced off `account_name_exists_exception`. `newaccount`
   * fails LOUDLY — that was luck. A re-pushed `transfer` / `deposit` succeeds
   * TWICE, silently. `clio push action` re-signs with fresh TAPOS, so a
   * re-push is a NEW transaction, never a duplicate the chain dedupes.
   *
   * @param label - Human label for the operation (logs + errors).
   * @param send - Performs the push; may be re-invoked ONLY on proven absence.
   * @param finality - How far to wait (default irreversible; see
   *   `irreversible-finality-only-never-head.md` — nothing weaker is allowed).
   * @returns The push result once `finality` is reached.
   */
  private withFinality<T extends WireClient.TransactionIdResponse>(
    label: string,
    send: () => Promise<T>,
    finality: WireClient.FinalityType = WireClient.DefaultFinality
  ): Promise<T> {
    const budgetMs = scaleTimeoutMs(
        ProtocolTiming.irreversibilityBudgetMs(this.config.finalizerCount ?? 0)
      ),
      attempt = async (attemptNumber: number): Promise<T> => {
        const pushedAtMs = Date.now(),
          // Pre-inclusion retry ONLY — a throwing `send` produced no
          // transaction id, so there is nothing to double-apply. Deliberately
          // NOT fused with the finality wait; fusing them is the defect above.
          result = await retry(send, {
            maxAttempts: WireClient.PushMaxAttempts,
            delayMs: WireClient.FinalityRetryDelayMs,
            label
          }),
          transactionId = WireClient.getTransactionId(result)
        // Nothing reached the chain: no id, or `setContract`'s settled-no-op
        // sentinel. Waiting on the sentinel polled a fake id for the full
        // budget and then re-ran `clio set contract` — see the constant.
        if (
          !isString(transactionId) ||
          !isNotEmpty(transactionId) ||
          transactionId === WireClient.NoTransactionSentTransactionId
        )
          return result
        const outcome = await this.awaitFinality({
          transactionId,
          label,
          finality,
          budgetMs,
          pushedAtMs
        })
        const resolved = await match(outcome.kind)
          .with(WireClient.FinalityOutcome.irreversible, async () => result)
          .with(WireClient.FinalityOutcome.unappliable, async () =>
            attemptNumber < WireClient.FinalityMaxAttempts
              ? attempt(attemptNumber + 1)
              : WireClient.throwFinality(label, outcome)
          )
          // No path to `attempt` — unresolved can NEVER re-push.
          .with(WireClient.FinalityOutcome.unresolved, async () =>
            WireClient.throwFinality(label, outcome)
          )
          .exhaustive()
        return resolved
      }
    return attempt(1)
  }

  /** Push and observe finality exactly once without resending the transaction. */
  private async withFinalityOnce<
    T extends WireClient.TransactionIdResponse
  >(
    label: string,
    send: () => Promise<T>,
    finality: WireClient.FinalityType = WireClient.DefaultFinality
  ): Promise<T> {
    const pushedAtMs = Date.now(),
      result = await send(),
      transactionId = WireClient.getTransactionId(result)
    if (
      !isString(transactionId) ||
      !isNotEmpty(transactionId) ||
      transactionId === WireClient.NoTransactionSentTransactionId
    )
      return result
    const outcome = await this.awaitFinality({
      transactionId,
      label,
      finality,
      budgetMs: scaleTimeoutMs(
        ProtocolTiming.irreversibilityBudgetMs(this.config.finalizerCount ?? 0)
      ),
      pushedAtMs
    })
    if (outcome.kind !== WireClient.FinalityOutcome.irreversible)
      throw new WireClient.TransactionFinalityError(
        label,
        transactionId,
        outcome.blockNum
      )
    return result
  }

  /**
   * Wait for `transactionId` to reach `finality`; on any failure, RE-READ the
   * transaction's status and classify what may be done about it.
   *
   * Every failure path funnels through the same re-read — a lapsed deadline, a
   * transaction never located in a block, a suspected fork, an RPC error. That
   * is why this closes the hole a per-error-type predicate leaves: it does not
   * matter which of the four sites failed.
   *
   * @param input - Transaction id, label, target finality, budget, push time.
   * @returns The classified outcome; only `unappliable` permits a re-push.
   */
  private async awaitFinality(
    input: WireClient.FinalityWaitInput
  ): Promise<WireClient.FinalityResult> {
    const { transactionId, finality, budgetMs } = input,
      deadlineMs = Date.now() + budgetMs,
      remainingMs = () => Math.max(deadlineMs - Date.now(), 0)

    let blockNum: number
    try {
      blockNum = await this.waitForTransactionInBlock(
        transactionId,
        remainingMs()
      )
    } catch (error) {
      // NOT a failed transaction — "I could not locate it in time". The
      // re-read below decides whether it is genuinely gone.
      log.warn(
        `${input.label}: tx ${transactionId} not located in a block — ${errorText(error)}`
      )
      return this.classifyUnresolved(input, null)
    }

    if (finality !== WireClient.FinalityType.irreversible)
      return {
        kind: WireClient.FinalityOutcome.irreversible,
        transactionId,
        blockNum,
        lib: null
      }

    const reached = await this.pollIrreversible(
      transactionId,
      blockNum,
      deadlineMs
    )
    return reached
      ? {
          kind: WireClient.FinalityOutcome.irreversible,
          transactionId,
          blockNum,
          lib: null
        }
      : this.classifyUnresolved(input, blockNum)
  }

  /**
   * Decide whether a transaction whose wait did NOT succeed may be re-pushed.
   *
   * Absence is NOT proof — `getTransaction` answers 404 for "not indexed" and
   * throws for "could not ask", and collapsing those is how an RPC hiccup gets
   * laundered into a fork-out that re-pushes an applied transaction. Only a
   * closed TAPOS window proves impossibility: this client pins the expiration
   * itself ({@link WireClient.TransactionExpirationSec}), so once head time is
   * past `pushedAt + expiration` AND the transaction is absent, it can never
   * be included and a re-push is safe.
   *
   * @param input - The original wait input (carries `pushedAtMs`).
   * @param blockNum - Where it was last seen, when it was located at all.
   * @returns `unappliable` only on proof; `unresolved` in every other case.
   */
  private async classifyUnresolved(
    input: WireClient.FinalityWaitInput,
    blockNum: number
  ): Promise<WireClient.FinalityResult> {
    const { transactionId, pushedAtMs } = input,
      located = await this.locateTransactionBlock(transactionId)

    // Applied (anywhere), or we could not ask — either way, never re-push.
    if (located.kind !== WireClient.TransactionLocation.absent)
      return {
        kind: WireClient.FinalityOutcome.unresolved,
        transactionId,
        blockNum: located.blockNum ?? blockNum,
        lib: await this.readLib()
      }

    const lib = await this.readLib(),
      headTimeMs = await this.readHeadTimeMs(),
      expiresAtMs =
        pushedAtMs +
        WireClient.TransactionExpirationSec * ProtocolTiming.MsPerSecond,
      expired = headTimeMs != null && headTimeMs > expiresAtMs
    return {
      kind: expired
        ? WireClient.FinalityOutcome.unappliable
        : WireClient.FinalityOutcome.unresolved,
      transactionId,
      blockNum,
      lib
    }
  }

  /** Current LIB, or null when the node cannot be reached. */
  private async readLib(): Promise<number> {
    try {
      return (await this.getInfo()).last_irreversible_block_num
    } catch (error) {
      log.warn(`readLib failed: ${errorText(error)}`)
      return null
    }
  }

  /** Head block time in epoch ms, or null when unreadable. */
  private async readHeadTimeMs(): Promise<number> {
    try {
      // Chain times are ISO-8601 WITHOUT a zone and are UTC; `Date.parse` would
      // read a bare stamp as LOCAL time, so the `Z` is appended explicitly.
      const { head_block_time } = await this.getInfo()
      return Date.parse(`${head_block_time.replace(/Z$/, "")}Z`)
    } catch (error) {
      log.warn(`readHeadTimeMs failed: ${errorText(error)}`)
      return null
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
    const location = await this.locateTransactionBlock(transactionId),
      locatedBlockNum =
        location.kind === WireClient.TransactionLocation.found
          ? location.blockNum
          : null,
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

  /**
   * Re-read WHERE a transaction currently sits.
   *
   * The three-way answer is the point. This previously did
   * `.catch(() => null)` and returned a bare number-or-null, so a trace-api
   * 500, a socket reset, or a capability mismatch became indistinguishable
   * from "the chain says it is not there" — and the caller read that as a
   * fork-out and re-pushed an applied transaction. `getTransaction` answers
   * 404 (authoritative: not indexed) or throws (we could not ask); those are
   * different facts and stay different here.
   *
   * @param transactionId - The transaction to look up.
   * @returns `found` with its block, `absent` on an authoritative 404, or
   *   `unknown` when the lookup itself failed.
   */
  private async locateTransactionBlock(
    transactionId: string
  ): Promise<WireClient.TransactionLocationResult> {
    try {
      const trace = await this.getTransaction(transactionId)
      return isObject(trace) && isNumber(trace.block_num) && trace.block_num > 0
        ? {
            kind: WireClient.TransactionLocation.found,
            blockNum: trace.block_num
          }
        : { kind: WireClient.TransactionLocation.absent, blockNum: null }
    } catch (error) {
      log.warn(
        `locateTransactionBlock(${transactionId}) could not read the trace — treating as UNKNOWN, not absent: ${errorText(error)}`
      )
      return { kind: WireClient.TransactionLocation.unknown, blockNum: null }
    }
  }

  /**
   * Poll until `transactionId` sits in an irreversible block.
   *
   * Renamed from the public `waitForTransactionIrreversible` deliberately: its
   * boolean meant two opposite things (forked out vs. deadline lapsed) and the
   * single caller inverted it into a "forked out" throw. Renaming makes any
   * un-migrated caller a compile error rather than a silent mis-read.
   *
   * @param transactionId - The transaction to follow.
   * @param blockNum - Block it was first seen in.
   * @param deadlineMs - Absolute deadline (epoch ms) shared with the inclusion
   *   wait, so one budget covers the whole finality wait rather than each
   *   waiter getting its own full copy.
   * @returns True once irreversible. False means ONLY "not confirmed here" —
   *   the caller re-reads to decide what that means; it is never proof of a
   *   fork.
   */
  private async pollIrreversible(
    transactionId: string,
    blockNum: number,
    deadlineMs: number
  ): Promise<boolean> {
    let height = blockNum
    while (Date.now() < deadlineMs) {
      try {
        const lib = (await this.getInfo()).last_irreversible_block_num
        if (lib >= height) {
          const block = await this.getBlock(height)
          if (WireClient.blockContainsTransaction(block, transactionId))
            return true
          const relocated = await this.locateTransactionBlock(transactionId)
          if (relocated.kind !== WireClient.TransactionLocation.found)
            return false
          height = relocated.blockNum
        }
      } catch (error) {
        log.debug(
          `pollIrreversible(${transactionId}) poll error: ${errorText(error)}`
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
  /**
   * A `get_table_rows` bound for a KV table whose key is ONE `uint64` field holding a `name`.
   *
   * With `json: true` the node parses each bound through `fc::json::from_string` and encodes it
   * with `be_key_codec::encode_key`, which calls `.get_object()` and looks every key field up BY
   * NAME (`chain_plugin.cpp` + `database_utils.hpp`). So the bound must be a JSON OBJECT keyed by
   * the ABI's `key_names`, carrying the name's raw uint64 — never the account string, which the
   * node cannot even parse as JSON ("Unexpected char '119' in \"wirercpt\"").
   *
   * The field name differs per table (`wireclaims.account` vs `payclaims.account_name`), so the
   * caller supplies it; the uint64 goes as a decimal STRING because it exceeds `Number.MAX_SAFE_INTEGER`.
   */
  export function nameKeyBound(field: string, account: string): string {
    return JSON.stringify({ [field]: Name.from(account).value.toString() })
  }

  /**
   * The single field a claimable-balance read consumes, shared by `sysio.reserv::wireclaims` and
   * `sysio.system::payclaims` — both rows carry `balance` in atomic units, serialized as a string
   * once it exceeds the JSON-safe integer range.
   *
   * Declared here rather than taken from `SysioContracts` because these two reads are deliberately
   * raw (see {@link WireClient.getWireClaimable}): the generated row types do not reach an
   * `@wireio/sdk-core` release until the contract ABIs land, so typing the generic against them
   * would couple this package's build to that release. It retires with the raw reads.
   */
  export interface ClaimableRow {
    balance: string | number
    /** `wireclaims` carries the row's owner here… */
    account?: string
    /** …and `payclaims` here. Exactly one is present, per that table's ABI. */
    account_name?: string
  }

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
  export interface SysioContractClient<Name extends SysioContractName> {
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

  /**
   * What a finality wait concluded — and therefore what may be done next.
   *
   * Three states, because a boolean cannot express them: "reached it",
   * "provably can never apply", and "I do not know yet". Conflating the last
   * two is what re-pushed an applied transaction.
   */
  export enum FinalityOutcome {
    /** Reached the requested finality. Done. */
    irreversible = "irreversible",
    /** PROVEN un-appliable (TAPOS window closed, still absent) — re-push is safe. */
    unappliable = "unappliable",
    /** State unknown or still applied — NEVER re-push. */
    unresolved = "unresolved"
  }

  /** Where a re-read found a transaction. */
  export enum TransactionLocation {
    /** In a block. */
    found = "found",
    /** The chain answered authoritatively that it is not indexed (404). */
    absent = "absent",
    /** The lookup itself failed — NOT evidence of absence. */
    unknown = "unknown"
  }

  /** A re-read's answer: where the transaction is, if anywhere. */
  export interface TransactionLocationResult {
    readonly kind: TransactionLocation
    /** Its block when `found`; null otherwise. */
    readonly blockNum: number
  }

  /** Everything {@link WireClient.awaitFinality} needs for one attempt. */
  export interface FinalityWaitInput {
    readonly transactionId: string
    readonly label: string
    readonly finality: FinalityType
    /** Whole-wait budget (ms) — ONE deadline covers inclusion + irreversibility. */
    readonly budgetMs: number
    /** When the push was issued — with the pinned expiration this proves impossibility. */
    readonly pushedAtMs: number
  }

  /** A classified finality outcome, carrying what the error message needs. */
  export interface FinalityResult {
    readonly kind: FinalityOutcome
    readonly transactionId: string
    /** Last known block, when known. */
    readonly blockNum: number
    /** LIB at classification time, when readable. */
    readonly lib: number
  }

  /**
   * Fail a finality wait with an error that states what was actually observed.
   *
   * The old message claimed `forked out before irreversibility` for a plain
   * timeout — actively false, and it misdirects whoever reads it. Context rides
   * `NestedError` (no marker class: `instanceof` fails OPEN across jest realms,
   * and this repo already documents that hazard in `ClioRunner`).
   *
   * @param label - The operation label.
   * @param result - The classified outcome.
   * @throws Always.
   */
  export function throwFinality(label: string, result: FinalityResult): never {
    throw new NestedError(
      match(result.kind)
        .with(
          FinalityOutcome.unappliable,
          () => `${label}: transaction can never apply (expiration window closed while absent)`
        )
        .otherwise(
          () => `${label}: finality unresolved — NOT re-pushed (the transaction may be applied)`
        ),
      { context: { ...result } }
    )
  }

  /**
   * Attempts for a push that THREW — i.e. produced no transaction id, so there
   * is nothing to double-apply. Separate from {@link FinalityMaxAttempts},
   * which bounds proven-safe re-pushes; fusing the two is the original defect.
   */
  export const PushMaxAttempts = 3

  /**
   * Seconds before a pushed transaction expires (clio `--expiration`).
   *
   * clio's own default is 30s. That is ample when the dialed node is producing,
   * but a cluster push must relay to whichever of N producers currently holds
   * the slot, so the inclusion window scales with topology and with any
   * propagation hiccup. 30s left no margin: a 21-producer bootstrap lost
   * `sysio.epoch::schbatchgps` to `expired_tx_exception` — a failure that names
   * the timer, not the cause. Sized well above the observed worst case; a tx
   * that cannot be included in this long has a real problem to diagnose, and
   * the surrounding finality wait bounds the step regardless.
   */
  export const TransactionExpirationSec = 120
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

  /**
   * Any push/transaction response carrying the chain's transaction id — the ONE
   * field the finality waiters read. {@link WireClient.withFinality} constrains
   * its send result on it; {@link getTransactionId} extracts it.
   */
  export interface TransactionIdResponse {
    transaction_id?: string
  }

  /** Extract `transaction_id` from a clio JSON response. */
  export function getTransactionId(result: unknown): string {
    if (typeof result === "string") {
      try {
        return JSON.parse(result)?.transaction_id ?? null
      } catch {
        const m = result.match(/"transaction_id"\s*:\s*"([a-f0-9]+)"/)
        return m ? m[1] : null
      }
    }
    if (result && typeof result === "object" && "transaction_id" in result)
      return (result as TransactionIdResponse).transaction_id
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
