import type { DebuggingClient } from "@wireio/debugging-client-shared"

import { ServiceId } from "./ServiceId.js"
import type { Service } from "./Service.js"
import type { ServiceManager } from "./ServiceManager.js"

/**
 * Holds the constructed {@link DebuggingClient} (either
 * `LocalFileDebuggingClient` or `NetDebuggingClient`) and drives its
 * `connect()` / `disconnect()` lifecycle through `ServiceManager`.
 *
 * Every service that needs the client (`OPPTrackingService`,
 * `ProcessMonitorService`, `LogTailingService`) declares
 * `dependsOn = [ServiceId.DebuggingClient]` and pulls the client out
 * via `manager.get<DebuggingClientService>(ServiceId.DebuggingClient).client`.
 */
export class DebuggingClientService implements Service {
  static readonly id = ServiceId.DebuggingClient
  static readonly dependsOn: readonly string[] = [] as const

  /**
   * @param client The constructed client. Construction lives outside this
   *               service so the cli can fail fast on bad CLI flags before
   *               any service plumbing runs.
   */
  constructor(readonly client: DebuggingClient) {}

  async init(_manager: ServiceManager): Promise<this> {
    return this
  }

  async start(_manager: ServiceManager): Promise<this> {
    await this.client.connect()
    return this
  }

  async stop(_manager: ServiceManager): Promise<this> {
    await this.client.disconnect()
    return this
  }
}
