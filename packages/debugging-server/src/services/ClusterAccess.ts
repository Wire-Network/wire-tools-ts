import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  ClusterFiles,
  type ClusterConfig,
  type ClusterState
} from "@wireio/cluster-tool-shared"
import { log } from "../logging/index.js"

/**
 * Reads `cluster-config.json` and `cluster-state.json` from a cluster
 * directory, caches the parsed payload, and refreshes on filesystem
 * change. Used by the cluster / process / log routes so they don't
 * re-parse the JSON on every request.
 *
 * The constructor is plain (no async setup) — `getConfig()` lazily reads
 * the file the first time it's called, which is also where missing-file
 * errors surface to the route handler.
 */
/**
 * Sentinel marking {@link ClusterAccess}'s state cache as not-yet-read —
 * distinct from `null`, which means "read, and no state file exists".
 */
enum StateCacheSentinel {
  unread = "unread"
}

export class ClusterAccess {
  private configCache: ClusterConfig | null = null
  private stateCache: ClusterState | null | StateCacheSentinel =
    StateCacheSentinel.unread
  private configWatcher: Fs.FSWatcher | null = null
  private stateWatcher: Fs.FSWatcher | null = null

  /**
   * @param clusterPath Absolute path to the cluster directory. Must be
   *                    the root that contains `cluster-config.json`.
   */
  constructor(readonly clusterPath: string) {}

  /** Begin watching both files. Idempotent. */
  start(): void {
    if (this.configWatcher) return
    const configFile = Path.join(this.clusterPath, ClusterFiles.ConfigFilename)
    try {
      this.configWatcher = Fs.watch(configFile, () => {
        this.configCache = null
      })
    } catch (err) {
      log.warn(`ClusterAccess: cannot watch ${configFile}`, err)
    }
    try {
      // Watch the parent dir — file may not exist yet.
      this.stateWatcher = Fs.watch(this.clusterPath, (_evt, filename) => {
        if (filename?.toString() === ClusterFiles.StateFilename) {
          this.stateCache = StateCacheSentinel.unread
        }
      })
    } catch (err) {
      log.warn(
        `ClusterAccess: cannot watch state file in ${this.clusterPath}`,
        err
      )
    }
  }

  /** Tear down watchers. Safe to call when not started. */
  stop(): void {
    try {
      this.configWatcher?.close()
    } catch {
      /* ignore */
    }
    this.configWatcher = null
    try {
      this.stateWatcher?.close()
    } catch {
      /* ignore */
    }
    this.stateWatcher = null
  }

  /**
   * Resolve and cache the cluster config. Throws when the file is
   * unreadable — the caller should surface the failure to the client.
   */
  async getConfig(): Promise<ClusterConfig> {
    if (this.configCache) return this.configCache
    const file = Path.join(this.clusterPath, ClusterFiles.ConfigFilename),
      raw = await Fs.promises.readFile(file, "utf8")
    this.configCache = JSON.parse(raw) as ClusterConfig
    return this.configCache
  }

  /**
   * Resolve the cluster state. Returns `null` when the file does not
   * exist — the harness writes it only after bootstrap completes.
   */
  async getState(): Promise<ClusterState> {
    if (this.stateCache !== StateCacheSentinel.unread) return this.stateCache
    const file = Path.join(this.clusterPath, ClusterFiles.StateFilename)
    if (!Fs.existsSync(file)) {
      this.stateCache = null
      return null
    }
    const raw = await Fs.promises.readFile(file, "utf8")
    this.stateCache = JSON.parse(raw) as ClusterState
    return this.stateCache
  }
}
