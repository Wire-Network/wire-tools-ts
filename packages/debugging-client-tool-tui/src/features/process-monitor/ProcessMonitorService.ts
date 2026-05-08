import {
  ClosedReason,
  StreamTopic,
  type PidSource,
  type ProcessLivenessEvent
} from "@wireio/debugging-shared"
import type {
  DebuggingClient,
  DebuggingSubscription
} from "@wireio/debugging-client-shared"

import { LoggingManager } from "../../logging/LoggingManager.js"
import { DebuggingClientService } from "../../services/DebuggingClientService.js"
import { ReduxService } from "../../services/ReduxService.js"
import { ServiceId } from "../../services/ServiceId.js"
import type { Service } from "../../services/Service.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import {
  removeProcess,
  setProcess
} from "../../store/process-monitor/ProcessMonitorSlice.js"

/**
 * Subscribes to the {@link StreamTopic.ProcessLiveness} stream on the
 * configured {@link DebuggingClient} and pumps diff events into the
 * process-monitor Redux slice. Also exposes a one-shot
 * `client.listProcessSources()` lookup for panels that need the full
 * source list (label + path metadata, not just liveness).
 */
export class ProcessMonitorService implements Service {
  static readonly id = ServiceId.ProcessMonitor
  static readonly dependsOn: readonly string[] = [
    ServiceId.Redux,
    ServiceId.DebuggingClient
  ]

  private readonly log = LoggingManager.getLogger(
    ProcessMonitorService.Category
  )
  private redux: ReduxService | null = null
  private client: DebuggingClient | null = null
  private subscription: DebuggingSubscription<ProcessLivenessEvent> | null =
    null
  private cachedSources: PidSource[] = []

  async init(manager: ServiceManager): Promise<this> {
    this.redux = manager.get<ReduxService>(ServiceId.Redux)
    this.client = manager.get<DebuggingClientService>(
      ServiceId.DebuggingClient
    ).client
    return this
  }

  async start(_manager: ServiceManager): Promise<this> {
    if (!this.client || !this.redux) return this
    // Seed the source cache so `listSources()` returns a populated list
    // even before the first stream tick lands.
    this.cachedSources = await this.client.listProcessSources()
    this.subscription = await this.client.subscribe(
      StreamTopic.ProcessLiveness,
      {}
    )
    this.subscription.on("event", evt => this.onEvent(evt))
    this.subscription.on("closed", reason =>
      this.log.warn(`process-liveness subscription closed: ${reason}`)
    )
    return this
  }

  async stop(_manager: ServiceManager): Promise<this> {
    this.subscription?.close(ClosedReason.ClientRequested)
    this.subscription = null
    return this
  }

  /** Latest source list cache. Returned by panels for label-driven lookups. */
  listSources(): PidSource[] {
    return this.cachedSources
  }

  private onEvent(evt: ProcessLivenessEvent): void {
    if (!this.redux) return
    evt.setSnapshots.forEach(snap => this.redux!.dispatch(setProcess(snap)))
    evt.removedLabels.forEach(label =>
      this.redux!.dispatch(removeProcess(label))
    )
    // Refresh the source-list cache opportunistically — the listing rarely
    // changes during a session but a new pid file can appear after a
    // standby promotion, etc.
    if (this.client) {
      void this.client
        .listProcessSources()
        .then(sources => {
          this.cachedSources = sources
        })
        .catch(err =>
          this.log.debug("listProcessSources refresh failed", err)
        )
    }
  }
}

export namespace ProcessMonitorService {
  /** Log category. */
  export const Category = "tui:process-monitor" as const
}
