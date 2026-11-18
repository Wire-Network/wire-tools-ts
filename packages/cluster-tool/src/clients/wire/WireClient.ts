import Assert from "node:assert"
import { promises as Fsp } from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { asOption, Either } from "@3fv/prelude-ts"
import { flatten, negate, uniq } from "lodash"
import { isMatching, match, P } from "ts-pattern"
import {
  getLogger,
  isNumber,
  isObject,
  isString,
  NestedError
} from "@wireio/shared"
import {
  type AbiProvider,
  Action,
  API,
  APIClient,
  type AnyAction,
  Asset,
  type Authority,
  Name,
  type PermissionLevelType,
  Serializer,
  type SignerProvider,
  SysioContracts
} from "@wireio/sdk-core"
import { ProtocolTiming } from "../../Constants.js"
import { assetUnits, scaleTimeoutMs, isNotEmpty, retry } from "../../utils/index.js"
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
// Each step of a derived index type is named, so every member is reusable and no definition
// spells more than one string literal — a renamed sdk-core member then fails at the one line
// that names it rather than inside a chain.
/** sdk-core's versioned API surface. */
type APIClientV1 = APIClient["v1"]
/** sdk-core's chain API — the root every chain call below derives from. */
type ChainAPI = APIClientV1["chain"]
/** sdk-core's `get_producer_schedule` call. */
type GetProducerScheduleCall = ChainAPI["get_producer_schedule"]
/** What `get_producer_schedule` answers, before projection onto plain names. */
type GetProducerScheduleResult = Awaited<ReturnType<GetProducerScheduleCall>>
/**
 * sdk-core's `producer_schedule` struct, exactly as `get_producer_schedule` answers it.
 *
 * The RAW struct, distinct from {@link WireClient.GetProducerScheduleResponse}, which is this
 * projected onto plain producer names.
 */
type ProducerScheduleStruct = GetProducerScheduleResult["active"]

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
  /** sdk-core clients keyed by the account whose `active` key each signs with — see {@link addSigner}. */
  private readonly signerClients = new Map<string, APIClient>()

  constructor(readonly config: WireClientConfig) {
    this.runner = new ClioRunner(config)
    this.wallet = new WireWallet(this.runner)
    // The recording provider lands every SDK RPC (table queries, get_info,
    // pushes) in the running step's Report extra — see RecordingFetchProvider.
    this.api = new APIClient({
      provider: new RecordingFetchProvider(config.nodeopUrl)
    })
  }

  // ── Signers (keys kiod never holds) ──────────────────────────────────────

  /**
   * Register the signer of `account`'s `active` key when kiod cannot hold the key (a
   * KMS-custodied WIRE K1): every push whose authorization actor is `account` is then built,
   * signed and sent through sdk-core (`APIClient.pushTransaction`) with the SAME finality wait
   * as a clio push — {@link withFinality}: irreversibility by default, a re-send only of a push
   * proven unapplied ({@link WireClient.isProvenUnapplied}).
   *
   * Each registration owns its OWN `APIClient` (over the recording provider, so its RPCs land
   * in the Report like every other SDK call): sdk-core keeps the signer as mutable client state
   * (`setSigner`), so one shared client would let concurrent pushes by different accounts sign
   * with each other's keys. Registering an account again replaces its client.
   *
   * The name parallels {@link WireWallet.addPrivateKey}: that imports a key for kiod to sign
   * with; this registers a signer for a key kiod never sees.
   *
   * @param account - The account whose `active` authority the signer's key satisfies.
   * @param signer - sdk-core signer for that key — `createClassicSigner` over local material,
   *   or the KMS arm of `keyPairUtils.wireSigner` for a KMS alias; only its public key is read.
   */
  addSigner(account: string, signer: SignerProvider): void {
    Assert.ok(isNotEmpty(account), "addSigner: an account name is required")
    Assert.ok(
      signer?.pubKey != null,
      `addSigner(${account}): a signer carrying its public key is required`
    )
    this.signerClients.set(
      account,
      new APIClient({
        provider: new RecordingFetchProvider(this.config.nodeopUrl),
        signer
      })
    )
    log.info(
      `WireClient: pushes authorized by ${account} sign with ${signer.pubKey} through sdk-core`
    )
  }

  /**
   * The sdk-core client registered for the actor every one of `authorizations` names — one
   * authorization list per action of the push — or `null` when no actor is registered, in
   * which case the push goes through clio and kiod as always.
   *
   * A signer-routed push carries exactly ONE signature, so once any actor is registered every
   * action must be authorized by that account, and by it alone: a second actor — registered
   * or not — needs a signature nothing here can produce, and a second permission of the same
   * account is not what the registered key was declared for. Such a push is refused before
   * anything is built or sent.
   *
   * @param label - The push's label, for the refusal.
   * @param authorizations - Each action's authorization, in action order.
   * @returns The registered client, or `null` for the clio path.
   */
  private resolveSignerClient(
    label: string,
    authorizations: ReadonlyArray<ReadonlyArray<PermissionLevelType>>
  ): APIClient {
    const actors = authorizations.flatMap(authorization =>
        authorization.map(level => String(level.actor))
      ),
      registered = uniq(actors.filter(actor => this.signerClients.has(actor)))
    if (registered.length === 0) return null
    const [account] = registered
    Assert.ok(
      authorizations.every(
        authorization =>
          authorization.length === 1 &&
          String(authorization[0].actor) === account
      ),
      `${label}: a signer-routed push carries exactly one signature, so every action must be authorized by ${account} alone — got ${authorizations
        .map(authorization =>
          authorization
            .map(level => `${level.actor}@${level.permission}`)
            .join(" + ")
        )
        .join(", ")}`
    )
    return this.signerClients.get(account)
  }

  /**
   * Build, sign and send `action` through a registered client — the signer-routed twin of
   * clio's `push action` / `push transaction`. sdk-core fetches each contract's ABI, takes
   * TAPOS at LIB with the SAME 120 s expiration this client pins on clio (its
   * `getTransactionHeader()` default equals {@link WireClient.TransactionExpirationSec}),
   * which is what keeps {@link classifyUnresolved}'s proof of impossibility valid for a signer
   * push; signs the digest through the registered `SignerProvider`; posts `push_transaction`.
   *
   * The answer is sdk-core's `PushTransactionResponse` — structurally the
   * `SendTransactionResponse` clio's `-j` output is typed as, minus the optional `except` a
   * failed trace carries (sdk-core throws on those instead) — so it is assignable without a
   * cast; this method is the ONE place that assignability is relied on.
   *
   * @param client - The client {@link addSigner} registered for the push's actor.
   * @param action - The action, or the whole action list of a multi-action transaction.
   * @returns The node's push response.
   */
  private pushSigned(
    client: APIClient,
    action: AnyAction | AnyAction[]
  ): Promise<API.v1.SendTransactionResponse> {
    return client.pushTransaction(action)
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
      options?.authorization ?? WireClient.activeAuthorization(account)
    return {
      prepare: (data, options) => ({
        contract,
        account,
        name: action,
        authorization: authorize(options),
        data
      }),
      invoke: (data, options) =>
        this.invoke(account, action, data, authorize(options), options)
    }
  }

  private tableQuery(
    account: string,
    table: string
  ): WireClient.TableQuery<any, any> {
    const rowsQuery = (
      args: WireClient.TableQueryArgs
    ): WireClient.TableRowsQuery => ({
      account,
      scope: args.scope ?? account,
      table,
      limit: args.limit,
      lowerBound: args.lowerBound,
      upperBound: args.upperBound
    })
    return {
      query: (args = {}) => this.getTableRows(rowsQuery(args)),
      queryAll: (args = {}) => this.getAllTableRows(rowsQuery(args))
    }
  }

  // ── Actions / transactions ───────────────────────────────────────────────

  /**
   * Single typed action; waits for finality by default (`skipWait` to fire-and-forget). Signed
   * by kiod through clio — or, when the authorization's actor has a registered signer
   * ({@link addSigner}), through sdk-core — with the same finality wait either way.
   */
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
      pushed: AnyAction = { account, name: action, authorization, data },
      signerClient = this.resolveSignerClient(label, [authorization]),
      sendViaClio = () =>
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
        ),
      send =
        signerClient != null
          ? () => this.pushSigned(signerClient, pushed)
          : sendViaClio
    if (options.skipWait) return send()
    return this.withFinality(label, send, options.finality)
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

  /**
   * Multi-action tx; variadic + flatten. Waits by default. A typed payload's
   * data is encoded by clio against the deployed ABI; an sdk-core
   * {@link Action} rides already encoded, for an action whose data the
   * generated payload types cannot carry (`sysio.msig::propose`'s whole
   * proposed transaction). When any action's actor has a registered signer
   * ({@link addSigner}), every action must be authorized by that one account
   * and the whole list is signed and sent through sdk-core instead of clio,
   * an encoded {@link Action} as it is.
   */
  async invokeTransaction(
    ...payloads: Array<
      | WireClient.ActionPayload<any, any>
      | WireClient.ActionPayload<any, any>[]
      | Action
    >
  ): Promise<API.v1.SendTransactionResponse> {
    const flattened = flatten(payloads),
      actions = flattened.map(payload =>
        payload instanceof Action
          ? WireClient.toEncodedActionJson(payload)
          : payload
      ),
      label = actions.map(a => `${a.account}::${a.name}`).join(","),
      signerClient = this.resolveSignerClient(
        label,
        actions.map(payload => payload.authorization)
      ),
      sendViaClio = () =>
        this.runner.run<API.v1.SendTransactionResponse>(
          [
            "push",
            "transaction",
            "-j",
            JSON.stringify({ actions }),
            ...this.expirationArgs
          ],
          { json: true }
        ),
      send =
        signerClient != null
          ? () =>
              this.pushSigned(
                signerClient,
                flattened.map(payload =>
                  payload instanceof Action
                    ? payload
                    : {
                        account: payload.account,
                        name: payload.name,
                        authorization: [...payload.authorization],
                        data: payload.data
                      }
                )
              )
          : sendViaClio
    return this.withFinality(label, send)
  }

  /**
   * Single action pushed via a temp transaction file — for large `data` (e.g.
   * `sysio.roa::setsyscode`'s wasm hex) that would exceed the command-line arg
   * limit (E2BIG). Waits for finality by default. A registered signer
   * ({@link addSigner}) never meets that limit — sdk-core posts the transaction
   * over HTTP — so its push goes exactly the way {@link invoke} sends one.
   */
  async invokeViaFile<Action extends object>(
    account: string,
    action: string,
    data: Action,
    authorization: PermissionLevelType[],
    options: WireClient.InvocationOptions = {}
  ): Promise<API.v1.SendTransactionResponse> {
    const label = `${account}::${action} (file)`,
      pushed: AnyAction = { account, name: action, authorization, data },
      signerClient = this.resolveSignerClient(label, [authorization]),
      sendViaFile = async () => {
        const file = Path.join(
          Os.tmpdir(),
          `wire-trx-${account}-${action}-${process.pid}-${Date.now()}.json`
        )
        await Fsp.writeFile(file, JSON.stringify({ actions: [pushed] }))
        try {
          return await this.runner.run<API.v1.SendTransactionResponse>(
            ["push", "transaction", "-j", file, ...this.expirationArgs],
            { json: true }
          )
        } finally {
          await Fsp.unlink(file).catch(() => {})
        }
      },
      send =
        signerClient != null
          ? () => this.pushSigned(signerClient, pushed)
          : sendViaFile
    if (options.skipWait) return send()
    return this.withFinality(label, send, options.finality)
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
    return this.invoke(
      "sysio",
      "activate",
      { feature_digest: featureDigest },
      WireClient.activeAuthorization("sysio")
    )
  }

  /** Mark `account` privileged (sysio.bios::setpriv), waiting for irreversibility. */
  setPriv(account: string): Promise<API.v1.SendTransactionResponse> {
    return this.invoke(
      "sysio",
      "setpriv",
      { account, is_priv: 1 },
      WireClient.activeAuthorization("sysio")
    )
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

  /**
   * Raise `account`'s RAM limit by `ramBytes` (`sysio::setacctram`, signed
   * `sysio@active`), waiting for finality. `setacctram` sets an absolute limit,
   * so the grant is the account's current limit plus `ramBytes`.
   *
   * Bootstrap uses this for `sysio.andon`, whose native permissions and action
   * links outgrow its code + abi allowance, and for the governance authorities
   * `sysio.nodes` and `sysio.cncl`, whose `active` `sysio.councl` rewrites. OPP
   * bond rows use the privileged request issuer's system-pool payer, so batch
   * operators need no separate bond-row grant. Other accounts' RAM needs depend
   * on the rows they create and the payer selected for those rows.
   *
   * @param account - The account whose RAM limit is raised.
   * @param ramBytes - Bytes added to the account's current RAM limit.
   * @returns The `setacctram` push response.
   */
  async grantRam(
    account: string,
    ramBytes: number
  ): Promise<API.v1.SendTransactionResponse> {
    Assert.ok(
      Number.isSafeInteger(ramBytes) && ramBytes > 0,
      `grantRam: ${account}'s grant must be a positive byte count (got ${ramBytes})`
    )
    const ramQuota = await this.getRamQuota(account)
    Assert.ok(
      ramQuota >= 0,
      `grantRam: ${account} has an unlimited RAM limit, so there is nothing to grant`
    )
    return this.getSysioContract(SysioContractName.system).actions.setacctram.invoke(
      { account, ram_bytes: ramQuota + ramBytes }
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
   * Whether `account` is privileged (GET /v1/chain/get_account's `privileged`).
   * A privileged contract's inline actions skip the authorization check, which
   * is what lets `sysio.kicker` draw from `sysio` under `sysio@active`.
   *
   * @param account - The account to read.
   * @returns True iff the chain marks the account privileged.
   */
  async isPrivileged(account: string): Promise<boolean> {
    const { privileged } = await this.api.v1.chain.get_account(account)
    return privileged === true
  }

  /**
   * `account`'s RAM limit in bytes (GET /v1/chain/get_account's `ram_quota`).
   *
   * @param account - The account to read.
   * @returns The limit, or `-1` when the account is unlimited.
   */
  async getRamQuota(account: string): Promise<number> {
    const { ram_quota: ramQuota } = await this.api.v1.chain.get_account(account)
    return Number(ramQuota)
  }

  /**
   * GET /v1/chain/get_producer_schedule — the ACTIVE schedule, plus the pending / proposed ones
   * while a change is in flight — projected onto plain producer names the way {@link getInfo}
   * projects its scalars (sdk-core answers with `Name`-typed entries). A proposed schedule
   * becomes pending once its block is produced and active once that block is FINAL, so the
   * active list is the set actually taking turns.
   */
  async getProducerSchedule(): Promise<WireClient.GetProducerScheduleResponse> {
    const schedule = await this.api.v1.chain.get_producer_schedule(),
      project = (entry: ProducerScheduleStruct): WireClient.ProducerSchedule =>
        asOption(entry)
          .map(present => ({
            version: Number(present.version),
            producers: present.producers.map(producer =>
              String(producer.producer_name)
            )
          }))
          .getOrUndefined()
    return {
      active: project(schedule.active),
      pending: project(schedule.pending),
      proposed: project(schedule.proposed)
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
      row != null && typeof row === "object" && "value" in row ? row.value : row
    )
    return {
      rows: rows as Row[],
      more: result.more ?? false,
      nextKey: result.next_key?.toString()
    }
  }

  /**
   * Every row of a raw table read, page by page: each page resumes at the previous page's
   * `next_key` until the node reports no `more`. ESCAPE HATCH like {@link getTableRows};
   * prefer `getSysioContract(name).tables.<table>.queryAll(...)`.
   *
   * @param query - The read: its `limit` is the page size, its bounds the key range.
   * @returns Every row in the range, in key order.
   * @throws When a page reports `more` without a resume key past its own lower bound.
   */
  async getAllTableRows<Row = unknown>(
    query: WireClient.TableRowsQuery
  ): Promise<Row[]> {
    const page = await this.getTableRows<Row>(query)
    if (!page.more) {
      return page.rows
    }
    Assert.ok(
      page.nextKey != null && page.nextKey !== query.lowerBound,
      `WireClient: ${query.account}::${query.table} reported more rows but no resume key past ${query.lowerBound}`
    )
    return [
      ...page.rows,
      ...(await this.getAllTableRows<Row>({
        ...query,
        lowerBound: page.nextKey
      }))
    ]
  }

  /** Real WIRE token balance (raw 9-decimal base units), or 0n when no row. */
  async getWireBalance(account: string): Promise<bigint> {
    const rows = (await this.api.v1.chain.get_currency_balance(
      "sysio.token",
      account,
      "WIRE"
    )) as Asset[]
    if (!rows || rows.length === 0) return 0n
    return assetUnits(rows[0].toString())
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
  async claimPay(account: string, permission = WireClient.ActivePermission) {
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
  getProducers() {
    return this.getSysioContract(
      SysioContractName.system
    ).tables.producers.query()
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
  async getTransaction(id: string): Promise<WireClient.GetTransactionResponse> {
    return this.postTraceApi<WireClient.GetTransactionResponse>(
      "/v1/trace_api/get_transaction_trace",
      { id },
      `get_transaction(${id})`
    )
  }

  /**
   * Fetch a block's executed transactions, inline actions included, via
   * /v1/trace_api/get_block.
   *
   * @param blockNum - The block's height.
   * @return The traced block, or `null` while the node has not traced it.
   */
  async getBlockTrace(
    blockNum: number
  ): Promise<WireClient.GetBlockTraceResponse> {
    return this.postTraceApi<WireClient.GetBlockTraceResponse>(
      "/v1/trace_api/get_block",
      { block_num: blockNum },
      `get_block_trace(${blockNum})`
    )
  }

  /** POST to a trace-API route, whose 404 means the node holds no such trace (`null`). */
  private async postTraceApi<T>(
    route: string,
    body: object,
    label: string
  ): Promise<T> {
    const resp = await fetch(`${this.config.nodeopUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    return (await match(resp)
      .with({ ok: true }, r => r.json())
      .with({ status: 404 }, () => Promise.resolve(null))
      .otherwise(() => {
        throw new Error(`${label} failed: HTTP ${resp.status}`)
      })) as T
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
   * A registered signer's push ({@link addSigner}) holds to the same rule:
   * sdk-core BUILDS the transaction (`get_abi`, `get_info`) before it submits,
   * so an `APIError` at one of those paths is proof nothing was sent and is
   * re-sent like a refused connection; once `push_transaction` was posted,
   * only the node's own rejection code proves anything
   * ({@link WireClient.isSignerPushProvenUnapplied}).
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
          // Pre-inclusion retry ONLY of a push proven not applied: its connection failed or
          // the node rejected it (`WireClient.isProvenUnapplied`, whichever transport sent
          // it). Anything else may have reached the node and is never re-sent: clio — or a
          // registered signer — would sign it again as a second transaction. Deliberately
          // NOT fused with the finality wait; fusing them is the defect above.
          result = await retry(send, {
            maxAttempts: WireClient.PushMaxAttempts,
            delayMs: WireClient.FinalityRetryDelayMs,
            label,
            checkResult: negate(WireClient.isProvenUnapplied)
          }).catch(error => {
            throw WireClient.isProvenUnapplied(error)
              ? error
              : new NestedError(
                  `${label}: the push may have reached the node, so it is not re-sent; read its outcome on the chain before running it again`,
                  { cause: error }
                )
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
      return WireClient.chainTimeMs((await this.getInfo()).head_block_time)
    } catch (error) {
      log.warn(`readHeadTimeMs failed: ${errorText(error)}`)
      return null
    }
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
/**
 * `error` and every error it wraps, outermost first — a `NestedError`'s retained `causes` and
 * the native ES2022 `cause` link, followed until the chain ends or repeats.
 */
function causeChain(error: unknown): unknown[] {
  const seen = new Set<unknown>(),
    walk = (link: unknown): unknown[] => {
      if (!isObject(link) || seen.has(link)) return []
      seen.add(link)
      const wrapped = match<unknown>(link)
        .with({ causes: P.array() }, ({ causes }) => causes)
        .with({ cause: P.not(P.nullish) }, ({ cause }) => [cause])
        .otherwise(() => [])
      return [link, ...wrapped.flatMap(walk)]
    }
  return walk(error)
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
   * A chain timestamp (`head_block_time`, a table's `time_point` cell) in epoch ms. Chain
   * times are ISO-8601 WITHOUT a zone and are UTC; `Date.parse` would read a bare stamp as
   * LOCAL time, so the `Z` is appended explicitly.
   *
   * @param stamp - The chain's ISO-8601 stamp, with or without a trailing `Z`.
   * @returns The instant in epoch ms (`NaN` for an unparseable stamp).
   */
  export function chainTimeMs(stamp: string): number {
    return Date.parse(`${stamp.replace(/Z$/, "")}Z`)
  }

  /**
   * The exact `get_table_rows` range of ONE row of a KV table keyed by a single `symbol_code`
   * field: the node takes `lower_bound` inclusive and `upper_bound` EXCLUSIVE, so the range is
   * `[code, code + 1)`. A row whose VALUE carries no identity (`sysio.liq::yieldidx`) can only be
   * read this way — a lower bound alone hands back the NEXT symbol's row when the one asked for
   * does not exist. Same JSON-object encoding as {@link nameKeyBound}; a bare code string fails
   * at parse time exactly like a bare account name does.
   */
  export function symbolCodeKeyRange(
    field: string,
    code: string
  ): TableQueryArgs {
    const { value } = Asset.SymbolCode.from(code)
    return {
      lowerBound: JSON.stringify({ [field]: value.toString() }),
      upperBound: JSON.stringify({ [field]: value.adding(1).toString() })
    }
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
  /**
   * Any typed {@link ActionPayload} of any generated system contract — the element
   * of a transaction that mixes contracts, each payload still checked against its
   * own contract's action names and data.
   */
  export type AnyActionPayload = {
    [Name in SysioContractName]: {
      [Action in ActionName<Name>]: ActionPayload<Name, Action>
    }[ActionName<Name>]
  }[SysioContractName]
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
    /** The lower bound the next page starts at, when the node returned one. */
    nextKey?: string
  }
  export interface TableQuery<
    Name extends SysioContractName,
    Table extends TableName<Name>
  > {
    query(
      args?: TableQueryArgs
    ): Promise<TableQueryResult<TableRow<Name, Table>>>
    /**
     * Every row in the range, read page by page ({@link WireClient.getAllTableRows});
     * `limit` is the page size.
     */
    queryAll(args?: TableQueryArgs): Promise<TableRow<Name, Table>[]>
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
          () =>
            `${label}: transaction can never apply (expiration window closed while absent)`
        )
        .otherwise(
          () =>
            `${label}: finality unresolved — NOT re-pushed (the transaction may be applied)`
        ),
      { context: { ...result } }
    )
  }

  /**
   * Attempts for a push the node rejected or never received, so there is nothing to
   * double-apply (an ambiguous failure is never re-sent). Separate from
   * {@link FinalityMaxAttempts}, which bounds proven-safe re-pushes; fusing the two is
   * the original defect.
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

  /** The permission an account signs its own actions with. */
  export const ActivePermission = "active"
  /** The root permission of every account; it can change any of the account's permissions. */
  export const OwnerPermission = "owner"
  /**
   * The virtual permission a contract's own code holds: an authority that lists
   * `<contract>@sysio.code` lets that contract's inline actions act for it. No key
   * satisfies it.
   */
  export const CodePermission = "sysio.code"
  /** The parent `owner` carries, spelled empty: `owner` is every account's root permission. */
  export const OwnerParent = ""

  /**
   * `<account>@active` — the authorization for an action the ACCOUNT itself signs: a
   * producer's lifecycle (`regproducer`, `regfinkey`, `actfinkey`, `unregprod`), a reserve
   * owner's fee actions, a claim. The default `<contract>@active` the invoker would supply is
   * the wrong signer for every one of those, and each already names its account in the action
   * data (or the step input), so the authorization is DERIVED from it here — the ONE spelling —
   * rather than riding along as a second copy that could drift.
   *
   * @param account - The signing account.
   * @returns The single-entry authorization.
   */
  export function activeAuthorization(account: string): PermissionLevelType[] {
    return [{ actor: account, permission: ActivePermission }]
  }

  // ── Signer-routed pushes ──

  /**
   * Node's system-error codes of a connection that never opened: nothing reached the node,
   * so a push that failed with one is proven unapplied. `ECONNRESET`, `ETIMEDOUT` and the
   * provider's own request timeout are deliberately absent — those fail AFTER the request
   * may have been sent.
   */
  export enum ConnectionFailureCode {
    ECONNREFUSED = "ECONNREFUSED",
    ENOTFOUND = "ENOTFOUND",
    EAI_AGAIN = "EAI_AGAIN",
    EHOSTUNREACH = "EHOSTUNREACH",
    ENETUNREACH = "ENETUNREACH"
  }

  /** The {@link ConnectionFailureCode} members, for a membership test on an arbitrary `code`. */
  const ConnectionFailureCodes: ReadonlySet<string> = new Set(
    Object.values(ConnectionFailureCode)
  )

  /**
   * The chain-API paths that SUBMIT a signed transaction — exactly the three sdk-core's
   * `ChainAPI` posts one to: `push_transaction` (what `APIClient.pushTransaction` uses) and
   * the two `send_transaction` forms. An `APIError` raised at any OTHER path while
   * `pushTransaction` runs — `get_abi`, `get_info` — came from BUILDING the transaction,
   * before anything was sent.
   */
  export const TransactionSubmissionPaths = [
    "/v1/chain/push_transaction",
    "/v1/chain/send_transaction",
    "/v1/chain/send_transaction2"
  ] as const

  /** {@link TransactionSubmissionPaths}, for a membership test on an `APIError`'s `path`. */
  const TransactionSubmissionPathSet: ReadonlySet<string> = new Set(
    TransactionSubmissionPaths
  )

  /**
   * sdk-core's `APIError`, read structurally (an `instanceof` is false across jest realms):
   * the path it failed at, the response it was built from and the chain code off that
   * response — `0` when the response carried none.
   */
  const APIErrorShape = {
    path: P.string,
    response: { status: P.number },
    code: P.number
  }

  /** {@link APIErrorShape} whose code is in the chain-exception family: the node's own rejection. */
  const RejectionShape = {
    ...APIErrorShape,
    code: P.number
      .int()
      .between(
        ClioRunner.ChainErrorCodeMinimum,
        ClioRunner.ChainErrorCodeMaximum
      )
  }

  /**
   * True only when a failed push provably did not apply — whichever transport sent it — so
   * {@link WireClient.withFinality} may send it again: clio's evidence
   * ({@link ClioRunner.isProvenUnapplied}) or a registered signer's
   * ({@link isSignerPushProvenUnapplied}). Anything else may have reached the node and is
   * never re-sent.
   *
   * @param error - What the push threw.
   * @returns True when the push is proven unapplied.
   */
  export function isProvenUnapplied(error: unknown): boolean {
    return (
      ClioRunner.isProvenUnapplied(error) || isSignerPushProvenUnapplied(error)
    )
  }

  /**
   * True only when a push sent through a registered signer (`APIClient.pushTransaction`)
   * provably did not apply. sdk-core wraps every failure in a `NestedError`; its cause chain
   * is walked for one of three proofs: a connection that never opened
   * ({@link ConnectionFailureCode}, or the refused-connection wording of
   * {@link ClioRunner.TransportFailurePattern}); an `APIError` the node answered at a path
   * that submits nothing — `get_abi` / `get_info`, which `pushTransaction` calls while
   * BUILDING the transaction ({@link TransactionSubmissionPaths} names the paths that do
   * submit) — so the push was never sent, whatever the code; or the node's own rejection of
   * the SUBMITTED push — an `APIError` at a submission path whose code is in the
   * chain-exception family but neither `tx_duplicate` (the node already holds the
   * transaction) nor the HTTP-exception family a lost reply raises, the two codes
   * {@link ClioRunner.isProvenUnapplied} refuses as well. A timeout, a reset mid-reply, a
   * signing failure, a submission answered without a chain code: each may have reached the
   * node, and each answers false.
   *
   * @param error - What `pushTransaction` threw.
   * @returns True when the push is proven unapplied.
   */
  export function isSignerPushProvenUnapplied(error: unknown): boolean {
    const chain = causeChain(error)
    return (
      chain.some(isConnectionFailure) ||
      chain.some(isBuildFailure) ||
      chain.some(isSignerPushRejection)
    )
  }

  /** Whether `code` names a {@link ConnectionFailureCode}. */
  function isConnectionFailureCode(
    code: unknown
  ): code is ConnectionFailureCode {
    return isString(code) && ConnectionFailureCodes.has(code)
  }

  /** A cause-chain link that is a connection the node never answered. */
  function isConnectionFailure(link: unknown): boolean {
    return match(link)
      .with({ code: P.when(isConnectionFailureCode) }, () => true)
      .with(
        { message: P.string.regex(ClioRunner.TransportFailurePattern) },
        () => true
      )
      .otherwise(() => false)
  }

  /**
   * A cause-chain link that is the node refusing a call made while BUILDING the transaction
   * — an `APIError` at a path that submits nothing (`get_abi`, `get_info`) — so the push was
   * never sent, whatever the code.
   */
  function isBuildFailure(link: unknown): boolean {
    return (
      isMatching(APIErrorShape, link) &&
      !TransactionSubmissionPathSet.has(link.path)
    )
  }

  /**
   * A cause-chain link that is the node rejecting the SUBMITTED push with a code proving it
   * unapplied: a chain-family code that is neither `tx_duplicate` nor HTTP-exception family.
   */
  function isSignerPushRejection(link: unknown): boolean {
    return (
      isMatching(RejectionShape, link) &&
      TransactionSubmissionPathSet.has(link.path) &&
      link.code !== ClioRunner.DuplicateTransactionCode &&
      !ClioRunner.HttpExceptionPattern.test(
        `${ClioRunner.ChainErrorCodePrefix}${link.code}:`
      )
    )
  }

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

  /**
   * An already-encoded action as `clio push transaction` takes it: `data` is
   * the action's hex bytes, so clio needs no ABI to push it.
   */
  export interface EncodedActionJson {
    /** The contract account. */
    readonly account: string
    /** The action name. */
    readonly name: string
    /** The declared authorizations, in order. */
    readonly authorization: PermissionLevelType[]
    /** The encoded action data, as hex. */
    readonly data: string
  }

  /**
   * The {@link EncodedActionJson} form of an sdk-core {@link Action}.
   *
   * @param action - The encoded action.
   * @returns Its push form, every name spelled as a string.
   */
  export function toEncodedActionJson(action: Action): EncodedActionJson {
    return {
      account: String(action.account),
      name: String(action.name),
      authorization: action.authorization.map(level => ({
        actor: String(level.actor),
        permission: String(level.permission)
      })),
      data: action.data.hexString
    }
  }

  /**
   * The generated {@link SysioContracts.SysioSystemAuthorityType} form of an
   * sdk-core {@link Authority} — what `get_account` decodes a permission's
   * `required_auth` into — with every number plain and every name and key a
   * string (keys in sdk-core's `PUB_` spelling).
   *
   * @param authority - The decoded authority.
   * @returns Its threshold, keys and accounts as the generated type spells them.
   */
  export function toAuthorityType(
    authority: Authority
  ): SysioContracts.SysioSystemAuthorityType {
    return {
      threshold: Number(authority.threshold),
      keys: authority.keys.map(({ key, weight }) => ({
        key: String(key),
        weight: Number(weight)
      })),
      accounts: authority.accounts.map(({ permission, weight }) => ({
        permission: {
          actor: String(permission.actor),
          permission: String(permission.permission)
        },
        weight: Number(weight)
      }))
    }
  }

  /**
   * A traced action's data as its generated type. The trace API decodes `data`
   * into `params` with the ABI the contract held when the action ran, and omits
   * `params` when it holds no such ABI or cannot decode with it; such an action's
   * `data` is decoded here with the contract's ABI as `abis` reads it, the ABI the
   * generated type describes.
   *
   * @param abis - Reads the contract's ABI, only for an action without `params`;
   *   the caller picks the cache lifetime (an sdk-core `ABICache` per scan).
   * @param contract - The contract the action belongs to.
   * @param action - The action.
   * @param trace - A traced `action` of `contract`.
   * @returns The action's data.
   * @throws When `trace` is another action; the ABI read's own error when it
   *   fails; NestedError when `trace` carries no `params` and its `data` does
   *   not decode as `action`.
   */
  export async function decodeTraceActionData<
    Name extends SysioContractName,
    Action extends ActionName<Name>
  >(
    abis: AbiProvider,
    contract: Name,
    action: Action,
    trace: TraceAction
  ): Promise<ActionData<Name, Action>> {
    const { account } = SysioContractDefinitions[contract]
    Assert.ok(
      trace.account === account && trace.name === action,
      `a trace of ${trace.account}::${trace.name} is not ${account}::${action}`
    )
    return asOption(trace.params).match({
      // Untyped trace JSON, typed here once: the node decoded it as this action.
      Some: async params => params as ActionData<Name, Action>,
      None: () => decodeTraceData<ActionData<Name, Action>>(abis, account, trace)
    })
  }

  /**
   * `trace`'s encoded `data` decoded with `account`'s ABI, as the plain object
   * its generated type describes.
   */
  async function decodeTraceData<Data>(
    abis: AbiProvider,
    account: string,
    trace: TraceAction
  ): Promise<Data> {
    const abi = await abis.getAbi(Name.from(account))
    return Either.try(() =>
      Serializer.objectify(
        Action.from({
          account,
          name: trace.name,
          authorization: [],
          data: trace.data
        }).decodeData(abi)
      )
    )
      .ifLeft(error => {
        throw new NestedError(
          `a trace of ${account}::${trace.name} carries no decoded params, and its data does not decode with the ${account} ABI`,
          { cause: error, context: { data: trace.data } }
        )
      })
      .getOrThrow()
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
  /** One producer schedule — its version + its producers' on-chain names, in slot order. */
  export interface ProducerSchedule {
    version: number
    producers: string[]
  }
  /**
   * `get_producer_schedule` projected onto plain names. `pending` / `proposed` are present only
   * while a schedule change is in flight.
   */
  export interface GetProducerScheduleResponse {
    active: ProducerSchedule
    pending?: ProducerSchedule
    proposed?: ProducerSchedule
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
  /** One executed action in a trace-API response, inline actions and notifications included. */
  export interface TraceAction {
    /** The account whose code ran the action: `account` itself, or a notified one. */
    receiver: string
    /** The contract the action belongs to. */
    account: string
    /** The action. */
    name: string
    /** The encoded action data, as hex; the trace API always serves it. */
    data: string
    /**
     * The action data, decoded with the ABI in effect when it ran; each action has
     * its own type. Absent when the node holds no such ABI or cannot decode with it
     * — read it through {@link decodeTraceActionData}.
     */
    params?: unknown
  }
  /** One transaction in a traced block; failed transactions are never traced. */
  export interface TraceTransaction extends GetTransactionResponse {
    actions: TraceAction[]
  }
  /** Whether the trace API holds a block as final. */
  export enum BlockTraceStatus {
    irreversible = "irreversible",
    pending = "pending"
  }
  /** The `/v1/trace_api/get_block` response. */
  export interface GetBlockTraceResponse {
    number: number
    status: BlockTraceStatus
    transactions: TraceTransaction[]
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
