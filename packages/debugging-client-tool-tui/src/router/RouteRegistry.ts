import Assert from "node:assert"
import type { Route } from "./RouteTypes.js"

/**
 * Process-wide registry of routes. Feature providers register their routes
 * here via `FeatureProvider.registerRoutes(RouteRegistry)` at bootstrap; the
 * router only renders routes that are registered.
 */
export namespace RouteRegistry {
  const routes = new Map<string, Route>()

  /** Register a route. Throws on duplicate path. */
  export function register(route: Route): void {
    Assert.ok(route.path, "Route.path is required")
    Assert.ok(
      !routes.has(route.path),
      `Route "${route.path}" is already registered`
    )
    routes.set(route.path, route)
  }

  /** Every registered route in insertion order. */
  export function all(): readonly Route[] {
    return [...routes.values()]
  }

  /** Cyclable routes (the Shift+Tab rotation). Default `cyclable` is `true`. */
  export function cyclable(): readonly Route[] {
    return [...routes.values()].filter(r => r.cyclable !== false)
  }

  /** Find a route by path. */
  export function find(path: string): Route | undefined {
    return routes.get(path)
  }

  /** Routes owned by a given feature provider. */
  export function findByFeatureId(featureId: string): Route[] {
    return [...routes.values()].filter(r => r.featureId === featureId)
  }

  /** Test-only reset. */
  export function _resetForTests(): void {
    routes.clear()
  }
}
