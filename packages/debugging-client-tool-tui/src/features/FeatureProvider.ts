import type { ComponentProviders } from "../providers/ComponentProviders.js"
import type { RouteRegistry } from "../router/RouteRegistry.js"
import type { ServiceManager } from "../services/ServiceManager.js"

/**
 * Base class for a debugger — a bundle of Panels + StatusWidgets focused on
 * one feature area of the WIRE cluster.
 *
 * Two kinds exist:
 *   - Core providers (`isRequiredProvider = true`) are always active regardless
 *     of `--features`. `ProcessMonitor` is the canonical example — without it
 *     the TUI has nothing to show.
 *   - Feature providers opt in; they run only when `--features` is omitted
 *     (all on) or when their id is in the comma-separated list.
 *
 * Subclasses implement `registerComponents(providers)` to install UI
 * contributions, and (optionally) `registerServices(manager)` to register
 * `ServiceType`s with `ServiceManager`. Both hooks run exactly once, only for
 * providers in the active set.
 */
export interface FeatureProvider {
  /** Stable identifier — used for toggling, keying, and logging. */
  readonly id: string

  /** Human-readable name shown in the feature switcher. */
  readonly name: string

  /** Always-on providers (like `ProcessMonitor`) mark this true. */
  readonly isRequiredProvider: boolean

  /**
   * Install this provider's Panels and StatusWidgets into the registry.
   * Called by `FeatureProviderRegistry.add`; subclasses shouldn't invoke
   * `ComponentProviders.register` from outside this hook.
   */
  registerComponents(providers: ComponentProviders): void

  /**
   * Register Service types with the ServiceManager. Invoked only when this
   * provider is active. Optional — providers without any services omit it.
   */
  registerServices?(manager: ServiceManager): void

  /**
   * Register Route definitions with the router. Invoked only when this
   * provider is active. Each provider typically registers a single "primary"
   * route that renders its panel/widget composition as a full-screen view;
   * future dashboard / preset-layout routes can compose components from
   * multiple features by reaching into `ComponentProviders`.
   */
  registerRoutes?(routes: typeof RouteRegistry): void
}
