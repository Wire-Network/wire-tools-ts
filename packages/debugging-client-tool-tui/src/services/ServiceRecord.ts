import type { Service } from "./Service.js"
import type { ServiceType } from "./ServiceType.js"

/** Internal registry row — one per registered `ServiceType`. */
export interface ServiceRecord<T extends Service = Service> {
  readonly id: string
  readonly serviceType: ServiceType<T>
  /** Populated during boot's init phase; null before boot and after destroy. */
  service: T | null
  /** Resolved at registration time — throws if any dep id is not registered yet. */
  readonly dependsOn: ServiceRecord[]
}
