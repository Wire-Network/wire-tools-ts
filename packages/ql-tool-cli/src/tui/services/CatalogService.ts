import { ConnectionProfile, type CatalogSnapshot, type SchemaCatalog } from "@wireio/ql-shared"
import { getLogger, NestedError } from "@wireio/shared"

import type { CliContext } from "../../cli/index.js"
import { CatalogActions, type TuiStore } from "../store/index.js"
import type { TuiService, TuiServiceStartContext } from "./TuiService.js"
import { TuiServiceId } from "./TuiServiceId.js"

const log = getLogger(__filename)

/**
 * The schema browser's data: a {@link SchemaCatalog} for the active profile,
 * publishing each successive `CatalogSnapshot` into the store. Owners load in
 * the background at start (the UI never waits on `get_abi`); `describe` fills
 * logical types on demand; SCHEMA_CHANGED invalidates.
 */
export class CatalogService implements TuiService {
  /** Service id. */
  readonly id = TuiServiceId.catalog
  /** Needs the seeded store. */
  readonly dependsOn: readonly TuiServiceId[] = [TuiServiceId.store]
  private store: TuiStore = null
  private catalog: SchemaCatalog = null
  /** The background owner load started by the latest {@link start} / {@link useProfile}. */
  loading: Promise<void> = Promise.resolve()

  /**
   * @param context - The CLI context (catalog factory).
   */
  constructor(readonly context: CliContext) {}

  /**
   * Create the catalog and start loading every owner in the background.
   *
   * @param context - Store and boot profile.
   */
  async start(context: TuiServiceStartContext): Promise<void> {
    this.store = context.store
    this.useProfile(context.profile)
  }

  /** Drop the catalog. */
  async stop(): Promise<void> {
    this.catalog = null
    this.store = null
  }

  /**
   * Switch to another profile: a new catalog, owners reloaded in the background.
   *
   * @param profile - The new connection.
   */
  useProfile(profile: ConnectionProfile): void {
    this.catalog = this.context.createCatalog(profile)
    this.store.dispatch(CatalogActions.snapshotLoaded(this.catalog.snapshot))
    this.loading = this.loadOwners(this.catalog, ConnectionProfile.resolveOwners(profile))
  }

  /**
   * Describe a table (fills its value fields' logical types).
   *
   * @param owner - Owner account.
   * @param table - Table name.
   */
  async describe(owner: string, table: string): Promise<void> {
    const catalog = this.catalog
    try {
      this.publish(catalog, await catalog.describe(owner, table))
    } catch (error) {
      const message = NestedError.toError(error).message
      log.warn(`describe ${owner}.${table} failed: ${message}`)
      this.store?.dispatch(CatalogActions.loadFinished(`describe ${owner}.${table}: ${message}`))
    }
  }

  /**
   * SCHEMA_CHANGED: drop the cached ABIs and reload them in the background.
   *
   * @param owner - The owner to invalidate; omitted = every owner.
   */
  invalidate(owner?: string): void {
    const catalog = this.catalog,
      snapshot = catalog.invalidate(owner)
    this.publish(catalog, snapshot)
    this.loading = this.loadOwners(
      catalog,
      snapshot.owners.filter(candidate => !candidate.loaded).map(candidate => candidate.account)
    )
  }

  /** Load owners one by one; each success publishes a snapshot, each failure is logged and reported. */
  private async loadOwners(catalog: SchemaCatalog, owners: string[]): Promise<void> {
    this.store?.dispatch(CatalogActions.loadStarted())
    const failures: string[] = []
    for (const owner of owners) {
      try {
        this.publish(catalog, await catalog.loadOwner(owner))
      } catch (error) {
        const message = NestedError.toError(error).message
        log.warn(`loading the ABI of ${owner} failed: ${message}`)
        failures.push(owner)
      }
    }
    if (catalog === this.catalog) {
      this.store?.dispatch(
        CatalogActions.loadFinished(failures.length === 0 ? null : `could not load: ${failures.join(", ")}`)
      )
    }
  }

  /** Publish a snapshot unless the catalog was replaced meanwhile (profile switch). */
  private publish(catalog: SchemaCatalog, snapshot: CatalogSnapshot): void {
    if (catalog === this.catalog) this.store?.dispatch(CatalogActions.snapshotLoaded(snapshot))
  }
}
