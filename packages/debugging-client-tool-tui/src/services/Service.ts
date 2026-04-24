import type { ServiceManager } from "./ServiceManager.js"

/**
 * Lifecycle unit:
 *  - init(manager): resolve resources, validate config. No side effects.
 *  - start(manager): begin work (timers, watchers, subscriptions).
 *  - stop(manager):  tear down. Must be idempotent and must not throw.
 *
 * Each phase returns `Promise<Service>` (usually `this`) so chaining and typed
 * lookup flow cleanly through `ServiceManager`.
 */
export interface Service {
  init(manager: ServiceManager): Promise<Service>
  start(manager: ServiceManager): Promise<Service>
  stop(manager: ServiceManager): Promise<Service>
}
