import Fs from "node:fs"
import Path from "node:path"

import type { QueryHistoryEntry, SavedQuery, ConnectionProfile, ConnectionProfilesDocument } from "@wireio/ql-shared"
import {
  ConnectionProfileStore,
  JsonDocumentStore,
  QLPaths,
  QueryHistoryStore,
  SavedQueryStore,
  type JsonDocumentUnwatch
} from "@wireio/ql-shared/node"
import { getLogger, NestedError } from "@wireio/shared"

import { StoreKind, type HistoryListRequest, type SaveQueryRequest } from "../../common/index.js"

const log = getLogger(__filename)

/** Receives which store changed on disk. */
export type StoreChangeListener = (kind: StoreKind) => void

/** The stores the service fronts (injectable for tests; default: the shared `QLPaths` files). */
export interface StoreServiceOptions {
  /** profiles.json. */
  profiles?: ConnectionProfileStore
  /** saved-queries.json. */
  saved?: SavedQueryStore
  /** history.jsonl. */
  history?: QueryHistoryStore
}

/** Resolved stores. */
export interface StoreServiceConfig extends Required<StoreServiceOptions> {}

/**
 * Main-side owner of the persisted stores shared with `wql` (profiles, saved
 * queries, history). The isolated renderer reaches them only through IPC. Disk
 * changes — including another instance's writes — are reported per
 * {@link StoreKind} so every window reloads.
 */
export class StoreService {
  /** Resolved stores. */
  readonly config: StoreServiceConfig
  private readonly unwatches: JsonDocumentUnwatch[] = []

  /**
   * @param options - Store overrides.
   */
  constructor(options: StoreServiceOptions = {}) {
    const {
      profiles = new ConnectionProfileStore(QLPaths.profilesFile()),
      saved = new SavedQueryStore(QLPaths.savedQueriesFile()),
      history = new QueryHistoryStore({ file: QLPaths.historyFile() })
    } = options
    this.config = { profiles, saved, history }
  }

  /**
   * The profiles document.
   *
   * @returns The document.
   */
  profilesDocument(): ConnectionProfilesDocument {
    return this.config.profiles.read()
  }

  /**
   * Add or replace a profile.
   *
   * @param profile - The profile.
   * @returns The updated document.
   */
  upsertProfile(profile: ConnectionProfile): ConnectionProfilesDocument {
    this.config.profiles.upsert(profile)
    return this.profilesDocument()
  }

  /**
   * Remove a profile.
   *
   * @param name - Profile name.
   * @returns The updated document.
   */
  removeProfile(name: string): ConnectionProfilesDocument {
    this.config.profiles.remove(name)
    return this.profilesDocument()
  }

  /**
   * Set the default profile.
   *
   * @param name - Profile name.
   * @returns The updated document.
   */
  setDefaultProfile(name: string): ConnectionProfilesDocument {
    this.config.profiles.setDefault(name)
    return this.profilesDocument()
  }

  /**
   * Newest-first history.
   *
   * @param request - Limit and search text.
   * @returns The entries.
   */
  listHistory(request: HistoryListRequest): QueryHistoryEntry[] {
    return this.config.history.list({ limit: request.limit, search: request.search })
  }

  /**
   * Append one history record.
   *
   * @param entry - The record.
   */
  appendHistory(entry: QueryHistoryEntry): void {
    this.config.history.append(entry)
  }

  /** Truncate the history file. */
  clearHistory(): void {
    this.config.history.clear()
  }

  /**
   * Saved queries.
   *
   * @returns The entries.
   */
  listSaved(): SavedQuery[] {
    return this.config.saved.list()
  }

  /**
   * Save (create or update by name).
   *
   * @param request - Name and SQL.
   * @returns The updated list.
   */
  saveQuery(request: SaveQueryRequest): SavedQuery[] {
    this.config.saved.save(request.name, request.query)
    return this.listSaved()
  }

  /**
   * Remove by id or name.
   *
   * @param idOrName - Id or name.
   * @returns The updated list.
   */
  removeSaved(idOrName: string): SavedQuery[] {
    this.config.saved.remove(idOrName)
    return this.listSaved()
  }

  /**
   * Watch every store file; `listener` receives the changed kind (debounced).
   *
   * @param listener - Change listener.
   */
  watch(listener: StoreChangeListener): void {
    this.unwatches.push(
      this.config.profiles.watch(() => listener(StoreKind.profiles)),
      this.config.saved.watch(() => listener(StoreKind.saved)),
      StoreService.watchFile(this.config.history.file, () => listener(StoreKind.history))
    )
  }

  /** Stop every watch. */
  close(): void {
    this.unwatches.splice(0).forEach(unwatch => unwatch())
  }
}

/** Service constants + helpers. */
export namespace StoreService {
  /** Coalescing window of history-file change notifications. */
  export const WatchDebounceMs = 50

  /**
   * Watch one file (through its directory, so appends and truncation both count).
   *
   * @param file - The file.
   * @param listener - Called once per debounced burst.
   * @returns Unsubscribe.
   */
  export function watchFile(file: string, listener: () => void): JsonDocumentUnwatch {
    const directory = Path.dirname(file),
      name = Path.basename(file)
    Fs.mkdirSync(directory, { recursive: true })
    let pending: ReturnType<typeof setTimeout> = null
    const watcher = Fs.watch(directory, (_event, changed) => {
      if (changed !== name) return
      if (pending != null) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        listener()
      }, WatchDebounceMs)
    })
    watcher.on(JsonDocumentStore.WatchErrorEvent, error =>
      log.warn(`watching ${file} failed: ${NestedError.toError(error).message}`, error)
    )
    return () => {
      if (pending != null) clearTimeout(pending)
      watcher.close()
    }
  }
}
