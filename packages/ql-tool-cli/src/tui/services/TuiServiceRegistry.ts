import { NestedError } from "@wireio/shared"

import type { TuiService, TuiServiceStartContext } from "./TuiService.js"
import type { TuiServiceId } from "./TuiServiceId.js"

/** What {@link TuiServiceRegistry.startAll} needs (the registry supplies itself). */
export interface TuiServiceBoot {
  /** The TUI store. */
  store: TuiServiceStartContext["store"]
  /** The boot connection. */
  profile: TuiServiceStartContext["profile"]
}

/**
 * The TUI's services. A service registers only after every service it depends
 * on, so registration order IS a valid start order — an unknown dependency (or
 * a self-dependency, the only cycle that order admits) throws at registration.
 * Start runs in that order; stop runs in reverse.
 */
export class TuiServiceRegistry {
  private readonly services = new Map<TuiServiceId, TuiService>()
  private started: TuiService[] = []

  /**
   * Register a service.
   *
   * @param service - The service.
   * @returns This registry.
   * @throws NestedError on a duplicate id, a self-dependency, or a dependency not yet registered.
   */
  register(service: TuiService): this {
    if (this.services.has(service.id)) {
      throw new NestedError(`TUI service ${service.id} is already registered`, { context: { id: service.id } })
    }
    if (service.dependsOn.includes(service.id)) {
      throw new NestedError(`TUI service ${service.id} depends on itself (dependency cycle)`, { context: { id: service.id } })
    }
    const unknown = service.dependsOn.filter(dependency => !this.services.has(dependency))
    if (unknown.length > 0) {
      throw new NestedError(`TUI service ${service.id} depends on unregistered services: ${unknown.join(", ")}`, {
        context: { id: service.id, unknown, registered: [...this.services.keys()] }
      })
    }
    this.services.set(service.id, service)
    return this
  }

  /**
   * A registered service.
   *
   * @param id - Its id.
   * @returns The service, typed by the caller.
   * @throws NestedError when not registered.
   */
  get<T extends TuiService>(id: TuiServiceId): T {
    const service = this.services.get(id)
    if (service == null) {
      throw new NestedError(`TUI service ${id} is not registered`, { context: { id, registered: [...this.services.keys()] } })
    }
    return service as T
  }

  /** Ids in start order. */
  get order(): TuiServiceId[] {
    return [...this.services.keys()]
  }

  /**
   * Start every service in dependency order; a failure stops the ones already started and rethrows.
   *
   * @param boot - Store and boot profile.
   */
  async startAll(boot: TuiServiceBoot): Promise<void> {
    const context: TuiServiceStartContext = { ...boot, registry: this }
    for (const service of this.services.values()) {
      try {
        await service.start(context)
      } catch (error) {
        await this.stopAll()
        throw new NestedError(`starting TUI service ${service.id} failed`, { cause: error, context: { id: service.id } })
      }
      this.started = [...this.started, service]
    }
  }

  /** Stop the started services in reverse order (each stop is awaited; failures are collected and rethrown). */
  async stopAll(): Promise<void> {
    const toStop = [...this.started].reverse(),
      failures: unknown[] = []
    this.started = []
    for (const service of toStop) {
      await service.stop().catch(error => failures.push(error))
    }
    if (failures.length > 0) throw new NestedError("stopping TUI services failed", { cause: failures })
  }
}
