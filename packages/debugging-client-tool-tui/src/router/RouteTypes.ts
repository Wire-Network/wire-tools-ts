import type React from "react"

/** URL-style param map for a matched route, e.g. `{ id: "42" }` for `/opp/epoch/:id`. */
export type RouteParams = Record<string, string>

/** Props the router passes to a route's component. */
export interface RouteComponentProps {
  /** Params parsed from the path. Empty when the route has no params. */
  params: RouteParams
}

/**
 * A registered route. Identified by `path`. The component is a fully-formed
 * React subtree; future dashboard/preset-layout routes can compose panels and
 * widgets from multiple feature packages by picking them from
 * `ComponentProviders` inside their component body.
 */
export interface Route {
  /** Stable path identifier, e.g. `"/process-monitor"`, `"/opp"`, `"/dashboard"`. */
  path: string
  /** Human-readable name — used in nav badges, breadcrumbs, and hotkey tooltips. */
  name: string
  /** Owning feature provider id (or a synthetic id for cross-feature routes like `"dashboard"`). */
  featureId: string
  /** React component rendered when this route is active. */
  component: React.ComponentType<RouteComponentProps>
  /**
   * When true, this route participates in the Shift+Tab cycling order. Custom
   * dashboards / detail routes may opt out to avoid cluttering the main rotation.
   * Defaults to true for every `FeatureProvider.registerRoutes` contribution.
   */
  cyclable?: boolean
}

/** A route plus the concrete params it was entered with. */
export interface RouteMatch {
  route: Route
  params: RouteParams
}
