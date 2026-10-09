import { defaults } from "lodash"

import { APIClient, type ABI } from "@wireio/sdk-core"
import { Deferred, getLogger, NestedError } from "@wireio/shared"

import type { ExecuteOptions, QueryEngineClient } from "../client/index.js"
import { ConnectionProfile } from "../profiles/index.js"
import { CatalogFieldRole } from "./CatalogNodeKind.js"
import {
  CatalogSnapshot,
  type CatalogField,
  type CatalogOwner,
  type CatalogTable
} from "./CatalogSnapshot.js"

const log = getLogger(__filename)

/** Schema catalog options (all optional). */
export interface SchemaCatalogOptions {
  /** Chain API client for `get_abi` (default: one on the profile endpoint). */
  chainAPI?: APIClient
}

/** Resolved schema catalog options. */
export interface SchemaCatalogConfig extends Required<SchemaCatalogOptions> {}

/**
 * Defaults for {@link SchemaCatalogOptions}: a chain API client on the
 * profile endpoint.
 *
 * @param profile - The connection.
 * @returns The default options.
 */
export function createSchemaCatalogDefaultOptions(profile: ConnectionProfile): Partial<SchemaCatalogOptions> {
  return { chainAPI: new APIClient({ url: profile.endpoint }) }
}

/**
 * Async loader producing successive {@link CatalogSnapshot}s: ABI (`get_abi`)
 * for tables + key/value fields, `LIMIT 0` describe for value logical types.
 */
export class SchemaCatalog {
  /** Resolved options. */
  readonly config: SchemaCatalogConfig
  private current: CatalogSnapshot

  /**
   * @param profile - The connection (endpoint + owners).
   * @param queryClient - Client used for describe probes.
   * @param options - Chain API override.
   */
  constructor(
    readonly profile: ConnectionProfile,
    readonly queryClient: QueryEngineClient,
    options: SchemaCatalogOptions = {}
  ) {
    // The defaults are created only when a member is missing — an injected
    // chain API client never instantiates a second one.
    const defaultOptions = options.chainAPI == null ? createSchemaCatalogDefaultOptions(profile) : {}
    this.config = defaults({ ...options }, defaultOptions) as SchemaCatalogConfig
    this.current = CatalogSnapshot.empty(
      profile.endpoint,
      ConnectionProfile.resolveOwners(profile)
    )
  }

  /** The latest snapshot. */
  get snapshot(): CatalogSnapshot {
    return this.current
  }

  /**
   * `get_abi(owner)`: tables plus key fields (ONLY from the ABI) and value fields.
   * An abort of `options.signal` rejects at once with the signal's reason and
   * leaves the snapshot unchanged (the chain API call itself cannot be cancelled;
   * its late answer is dropped).
   *
   * @param owner - Owner account (added to the snapshot when absent).
   * @param options - Cancellation (only `signal` applies to `get_abi`).
   * @returns The updated snapshot.
   * @throws NestedError when `get_abi` fails; the signal's abort reason itself when aborted.
   */
  async loadOwner(owner: string, options: ExecuteOptions = {}): Promise<CatalogSnapshot> {
    let response: Awaited<ReturnType<APIClient["v1"]["chain"]["get_abi"]>>
    try {
      response = await SchemaCatalog.untilAborted(this.config.chainAPI.v1.chain.get_abi(owner), options.signal)
    } catch (error) {
      if (options.signal?.aborted) {
        log.info(`get_abi(${owner}) abandoned: cancelled by the caller`)
        throw error
      }
      log.warn(`get_abi(${owner}) failed: ${NestedError.toError(error).message}`, error)
      throw new NestedError(`loading the ABI of ${owner} failed`, {
        cause: error,
        context: { owner, endpoint: this.profile.endpoint }
      })
    }
    const tables = response.abi == null ? [] : SchemaCatalog.tablesOf(response.abi)
    return this.replaceOwner({ account: owner, tables, loaded: true })
  }

  /**
   * `LIMIT 0` probe: fills logicalType for VALUE fields (`SELECT *` omits keys by design).
   * Loads the owner first when needed.
   *
   * @param owner - Owner account.
   * @param table - Table name.
   * @param options - Deadline / cancellation for the probe.
   * @returns The updated snapshot.
   */
  async describe(
    owner: string,
    table: string,
    options: ExecuteOptions = {}
  ): Promise<CatalogSnapshot> {
    const loaded = this.current.owners.find(candidate => candidate.account === owner)
    if (loaded == null || !loaded.loaded) await this.loadOwner(owner, options)
    const columns = await this.queryClient.describe(owner, table, options),
      ownerEntry = this.current.owners.find(candidate => candidate.account === owner),
      existing = CatalogSnapshot.findTable(this.current, owner, table),
      byName = new Map(columns.map(column => [column.name, column])),
      described: CatalogTable = {
        ...existing,
        described: true,
        fields: existing.fields.map(field =>
          field.role === CatalogFieldRole.value && byName.has(field.path)
            ? { ...field, logicalType: byName.get(field.path).logical_type }
            : field
        )
      }
    return this.replaceOwner({
      ...ownerEntry,
      tables: ownerEntry.tables.map(candidate =>
        candidate.name === table ? described : candidate
      )
    })
  }

  /**
   * SCHEMA_CHANGED → drop the cached ABI of `owner` (or every owner).
   *
   * @param owner - Owner to invalidate; omitted = all.
   * @returns The updated snapshot.
   */
  invalidate(owner?: string): CatalogSnapshot {
    this.current = {
      ...this.current,
      owners: this.current.owners.map(candidate =>
        owner == null || candidate.account === owner
          ? { account: candidate.account, tables: [], loaded: false }
          : candidate
      ),
      capturedAt: new Date().toISOString()
    }
    return this.current
  }

  /** Replace (or append) one owner entry. */
  private replaceOwner(entry: CatalogOwner): CatalogSnapshot {
    const present = this.current.owners.some(candidate => candidate.account === entry.account)
    this.current = {
      ...this.current,
      owners: present
        ? this.current.owners.map(candidate =>
            candidate.account === entry.account ? entry : candidate
          )
        : [...this.current.owners, entry],
      capturedAt: new Date().toISOString()
    }
    return this.current
  }
}

/** Pure ABI → catalog derivations. */
export namespace SchemaCatalog {
  /** Path prefix of primary-key fields in queries (`key.id`). */
  export const KeyPathPrefix = "key."
  /** The `AbortSignal` event an abort fires. */
  export const AbortEvent = "abort"

  /**
   * `work`, rejected with the signal's reason as soon as `signal` aborts (an
   * already-aborted signal rejects before waiting). The listener is removed when
   * the race settles.
   *
   * @param work - The pending operation.
   * @param signal - Cancellation (none = `work` itself).
   * @returns `work`'s outcome, or the abort.
   */
  export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal == null) return work
    if (signal.aborted) return Promise.reject(signal.reason)
    const aborted = new Deferred<T>(),
      onAbort = () => aborted.reject(signal.reason)
    signal.addEventListener(AbortEvent, onAbort, { once: true })
    return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener(AbortEvent, onAbort))
  }

  /**
   * Catalog tables of an ABI: key fields from `key_names`/`key_types`, value
   * fields from the row struct (base fields first, typedefs resolved).
   *
   * @param abi - The ABI definition.
   * @returns Tables in ABI order.
   */
  export function tablesOf(abi: ABI.Def): CatalogTable[] {
    return (abi.tables ?? []).map(table => ({
      name: table.name,
      rowType: table.type,
      described: false,
      fields: [
        ...table.key_names.map(
          (name, index): CatalogField => ({
            path: `${KeyPathPrefix}${name}`,
            role: CatalogFieldRole.key,
            abiType: table.key_types[index],
            logicalType: null
          })
        ),
        ...structFields(abi, table.type).map(
          (field): CatalogField => ({
            path: field.name,
            role: CatalogFieldRole.value,
            abiType: field.type,
            logicalType: null
          })
        )
      ]
    }))
  }

  /**
   * Fields of a struct (after typedef resolution), base struct fields first.
   *
   * @param abi - The ABI definition.
   * @param typeName - Struct (or typedef) name.
   * @returns The fields; empty when the type is not a struct.
   */
  export function structFields(abi: ABI.Def, typeName: string): ABI.Field[] {
    const resolved =
        (abi.types ?? []).find(typeDef => typeDef.new_type_name === typeName)?.type ?? typeName,
      struct = (abi.structs ?? []).find(candidate => candidate.name === resolved)
    return struct == null
      ? []
      : [...(struct.base ? structFields(abi, struct.base) : []), ...struct.fields]
  }
}
