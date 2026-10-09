import type { ConnectionProfile } from "@wireio/ql-shared"

import type { TuiStore } from "../store/index.js"
import type { TuiServiceId } from "./TuiServiceId.js"
import type { TuiServiceRegistry } from "./TuiServiceRegistry.js"

/** What a service receives at start (composes the domain objects; no loose primitives). */
export interface TuiServiceStartContext {
  /** The TUI store. */
  store: TuiStore
  /** The connection the TUI boots with. */
  profile: ConnectionProfile
  /** The registry (services reach their dependencies through it). */
  registry: TuiServiceRegistry
}

/** A wql TUI service: started in dependency order, stopped in reverse. */
export interface TuiService {
  /** Its id. */
  readonly id: TuiServiceId
  /** Services that must start first. */
  readonly dependsOn: readonly TuiServiceId[]
  /**
   * Start.
   *
   * @param context - Store, boot profile and registry.
   */
  start(context: TuiServiceStartContext): Promise<void>
  /** Stop (release watchers, cancel work). */
  stop(): Promise<void>
}
