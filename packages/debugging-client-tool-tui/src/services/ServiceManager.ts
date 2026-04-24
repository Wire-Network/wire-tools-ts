import Assert from "node:assert"
import Bluebird from "bluebird"
import { match } from "ts-pattern"
import { LoggingManager } from "../logging/LoggingManager.js"
import type { Service } from "./Service.js"
import type { ServiceRecord } from "./ServiceRecord.js"
import type { ServiceType } from "./ServiceType.js"

/**
 * Singleton lifecycle coordinator. Services register a `ServiceType` with an id
 * and string dependency list; `boot()` constructs + initialises + starts them
 * in topological order, `destroy()` stops them in reverse.
 *
 * Dependency ids must already be registered when a dependent registers — this
 * enforces registration order at the call site, not at boot time.
 */
export class ServiceManager {
  private readonly serviceRecordMap = new Map<string, ServiceRecord>()
  private configurable = true
  private booted = false
  private readonly log = LoggingManager.getLogger(ServiceManager.Category)

  private constructor() {}

  /**
   * Register a service type. Throws on duplicate id or unresolved dep.
   *
   * @param serviceType class with static `id` + `dependsOn`
   * @return `this` for fluent chaining
   */
  register<T extends Service>(serviceType: ServiceType<T>): this {
    Assert.ok(
      this.configurable,
      "ServiceManager already booted; cannot register more services"
    )
    Assert.ok(serviceType?.id, "ServiceType.id is required")
    Assert.ok(
      !this.serviceRecordMap.has(serviceType.id),
      `Service "${serviceType.id}" is already registered`
    )
    const depRecords: ServiceRecord[] = (serviceType.dependsOn ?? []).map(
      depId => {
        const dep = this.serviceRecordMap.get(depId)
        Assert.ok(
          dep,
          `Service "${serviceType.id}" depends on "${depId}" which is not yet registered`
        )
        return dep
      }
    )
    const rec: ServiceRecord<T> = {
      id: serviceType.id,
      serviceType,
      service: null,
      dependsOn: depRecords
    }
    this.serviceRecordMap.set(serviceType.id, rec)
    return this
  }

  /** Lookup a registered record without asserting boot status. */
  find(id: string): ServiceRecord | undefined {
    return this.serviceRecordMap.get(id)
  }

  /** Fetch a booted service instance by id. Throws if unregistered or pre-boot. */
  get<T extends Service>(id: string): T {
    const rec = this.serviceRecordMap.get(id)
    Assert.ok(rec, `Service "${id}" is not registered`)
    Assert.ok(rec.service, `Service "${id}" has not been booted yet`)
    return rec.service as T
  }

  /**
   * Topologically sorted records, Kahn's algorithm via a recursive drain.
   * Throws if a dependency cycle is detected.
   */
  get serviceRecordsByBootOrder(): ServiceRecord[] {
    const records = [...this.serviceRecordMap.values()],
      inDegree = new Map<string, number>(
        records.map(r => [r.id, r.dependsOn.length])
      ),
      dependentsOf = new Map<string, ServiceRecord[]>(
        records.map(r => [r.id, []])
      )
    records.forEach(r =>
      r.dependsOn.forEach(dep => dependentsOf.get(dep.id)!.push(r))
    )
    const initialReady = records.filter(r => inDegree.get(r.id) === 0),
      order = ServiceManager.drain(
        initialReady,
        [],
        inDegree,
        dependentsOf
      )
    Assert.ok(
      order.length === records.length,
      `Cycle detected in service deps; unresolved: ${records
        .filter(r => !order.includes(r))
        .map(r => r.id)
        .join(", ")}`
    )
    return order
  }

  /** Construct + init + start every service in topological order. */
  async boot(): Promise<void> {
    Assert.ok(
      this.configurable,
      "ServiceManager is not configurable (already booted)"
    )
    this.configurable = false
    const records = this.serviceRecordsByBootOrder
    this.log.info(
      `Initializing ${records.length} service(s): ${records
        .map(r => r.id)
        .join(", ")}`
    )
    try {
      await Bluebird.each(records, async r => {
        r.service = new r.serviceType()
        await r.service.init(this)
      })
      this.log.info("Starting services")
      await Bluebird.each(records, r =>
        r.service!.start(this).then(() => undefined)
      )
      this.booted = true
    } catch (err) {
      this.log.error("Boot failure — tearing down initialized services", err)
      await this.destroy()
      throw err
    }
  }

  /** Stop every instantiated service in reverse boot order; aggregates stop errors. */
  async destroy(): Promise<void> {
    const startedReverse = this.serviceRecordsByBootOrder
      .filter(r => !!r.service)
      .reverse()
    const errors = await Bluebird.reduce<ServiceRecord, unknown[]>(
      startedReverse,
      async (acc, r) => {
        try {
          await r.service!.stop(this)
        } catch (err) {
          this.log.error(`Failed to cleanly stop service "${r.id}"`, err)
          acc.push(err)
        } finally {
          r.service = null
        }
        return acc
      },
      []
    )
    this.booted = false
    this.configurable = true
    if (errors.length > 0) {
      throw new AggregateError(
        errors as Error[],
        "One or more services failed to stop cleanly"
      )
    }
  }

  private static instance: ServiceManager | null = null

  /** Singleton accessor — lazy-initializes on first call. */
  static get(): ServiceManager {
    if (!this.instance) this.instance = new ServiceManager()
    return this.instance
  }

  /** Convenience: `ServiceManager.register(ReduxService)`. */
  static register<T extends Service>(type: ServiceType<T>): void {
    this.get().register(type)
  }

  /**
   * Test-only hook — destroys any booted services and clears the singleton so
   * the next `get()` returns a fresh instance. Never call in production.
   */
  static async resetForTests(): Promise<void> {
    if (this.instance && this.instance.booted) {
      await this.instance.destroy()
    }
    this.instance = null
  }

  /**
   * Recursive Kahn's drain — replaces the imperative `while` loop.
   * Stable ordering for deterministic boot output.
   */
  private static drain(
    ready: ServiceRecord[],
    order: ServiceRecord[],
    inDegree: Map<string, number>,
    dependentsOf: Map<string, ServiceRecord[]>
  ): ServiceRecord[] {
    return match(ready)
      .with([], () => order)
      .otherwise(([next, ...rest]) => {
        order.push(next!)
        const freshReady = dependentsOf.get(next!.id)!.reduce<ServiceRecord[]>(
          (acc, dep) => {
            const newDeg = inDegree.get(dep.id)! - 1
            inDegree.set(dep.id, newDeg)
            return newDeg === 0 ? [...acc, dep] : acc
          },
          rest
        )
        return ServiceManager.drain(freshReady, order, inDegree, dependentsOf)
      })
  }
}

export namespace ServiceManager {
  /** Log category for ServiceManager itself. */
  export const Category = "tui:service-manager" as const
}
