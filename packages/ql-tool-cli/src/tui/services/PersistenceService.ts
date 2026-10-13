import type { JsonDocumentUnwatch } from "@wireio/ql-shared/node"
import type { ConnectionProfile, QueryHistoryEntry, SavedQuery } from "@wireio/ql-shared"

import type { CliContext } from "../../cli/index.js"
import { recordHistory } from "../../utils/index.js"
import { ConnectionActions, HistoryActions, SavedActions, type TuiStore } from "../store/index.js"
import type { TuiService, TuiServiceStartContext } from "./TuiService.js"
import { TuiServiceId } from "./TuiServiceId.js"

/**
 * The TUI's view of the shared stores (`profiles.json`, `saved-queries.json`,
 * `history.jsonl` — the same files the CLI and GUI use). Loads them into the
 * store at start and watches the JSON documents so another instance's writes
 * appear live (last writer wins).
 */
export class PersistenceService implements TuiService {
  /** Service id. */
  readonly id = TuiServiceId.persistence
  /** Needs the seeded store. */
  readonly dependsOn: readonly TuiServiceId[] = [TuiServiceId.store]
  private store: TuiStore = null
  private unwatches: JsonDocumentUnwatch[] = []

  /**
   * @param context - The CLI context holding the stores.
   */
  constructor(readonly context: CliContext) {}

  /**
   * Load every document and start watching.
   *
   * @param context - Store, profile and registry.
   */
  async start(context: TuiServiceStartContext): Promise<void> {
    const { profileStore, savedQueryStore } = this.context
    this.store = context.store
    this.reloadProfiles()
    this.reloadSaved()
    this.reloadHistory()
    this.unwatches = [
      profileStore.watch(document => this.store?.dispatch(ConnectionActions.profilesLoaded(document))),
      savedQueryStore.watch(document => this.store?.dispatch(SavedActions.itemsLoaded(document.queries)))
    ]
  }

  /** Stop watching. */
  async stop(): Promise<void> {
    this.unwatches.forEach(unwatch => unwatch())
    this.unwatches = []
    this.store = null
  }

  /**
   * Append a history record best-effort (a failed append is logged, never fatal)
   * and refresh the History route.
   *
   * @param entry - The record.
   * @returns Whether the record was appended.
   */
  appendHistory(entry: QueryHistoryEntry): boolean {
    const appended = recordHistory(this.context.historyStore, entry)
    this.reloadHistory()
    return appended
  }

  /**
   * Remove every history record and refresh the History route (an append
   * racing the clear may survive — the same contract as `wql history clear`).
   */
  clearHistory(): void {
    this.context.historyStore.clear()
    this.reloadHistory()
  }

  /**
   * Save the query under a name.
   *
   * @param name - Display name.
   * @param query - SQL text.
   * @returns The saved entry.
   */
  saveQuery(name: string, query: string): SavedQuery {
    const saved = this.context.savedQueryStore.save(name, query)
    this.reloadSaved()
    return saved
  }

  /**
   * Remove a saved query.
   *
   * @param idOrName - Id or name.
   */
  removeSavedQuery(idOrName: string): void {
    this.context.savedQueryStore.remove(idOrName)
    this.reloadSaved()
  }

  /**
   * Add or replace (by name) a profile.
   *
   * @param profile - The validated profile.
   * @returns The saved profile.
   */
  saveProfile(profile: ConnectionProfile): ConnectionProfile {
    const saved = this.context.profileStore.upsert(profile)
    this.reloadProfiles()
    return saved
  }

  /**
   * Make a profile the default.
   *
   * @param profile - The profile.
   */
  setDefaultProfile(profile: ConnectionProfile): void {
    this.context.profileStore.setDefault(profile.name)
    this.reloadProfiles()
  }

  /**
   * Remove a profile.
   *
   * @param profile - The profile.
   */
  removeProfile(profile: ConnectionProfile): void {
    this.context.profileStore.remove(profile.name)
    this.reloadProfiles()
  }

  /** Re-read `profiles.json` into the store. */
  private reloadProfiles(): void {
    this.store.dispatch(ConnectionActions.profilesLoaded(this.context.profileStore.read()))
  }

  /** Re-read `saved-queries.json` into the store. */
  private reloadSaved(): void {
    this.store.dispatch(SavedActions.itemsLoaded(this.context.savedQueryStore.list()))
  }

  /** Re-read the history tail into the store. */
  private reloadHistory(): void {
    this.store.dispatch(HistoryActions.itemsLoaded(this.context.historyStore.list()))
  }
}
