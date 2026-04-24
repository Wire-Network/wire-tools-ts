import { asOption } from "@3fv/prelude-ts"
import { ComponentProviders } from "../providers/ComponentProviders.js"
import { RouteRegistry } from "../router/RouteRegistry.js"
import { ServiceManager } from "../services/ServiceManager.js"
import type { FeatureProvider } from "./FeatureProvider.js"

/** Process-wide registry of active feature providers. */
export namespace FeatureProviderRegistry {
  const registry = new Map<string, FeatureProvider>()

  /**
   * Register a provider: install components and (optionally) services.
   * The caller is responsible for filtering providers against `--features`
   * before invoking `add` — the registry does not re-check activation.
   */
  export function add(provider: FeatureProvider): FeatureProvider {
    registry.set(provider.id, provider)
    provider.registerComponents(ComponentProviders)
    asOption(provider.registerServices).ifSome(fn =>
      fn.call(provider, ServiceManager.get())
    )
    asOption(provider.registerRoutes).ifSome(fn =>
      fn.call(provider, RouteRegistry)
    )
    return provider
  }

  /** Every registered provider, in insertion order. */
  export function all(): readonly FeatureProvider[] {
    return [...registry.values()]
  }

  /** Lookup by id. */
  export function find(id: string): FeatureProvider | undefined {
    return registry.get(id)
  }
}
