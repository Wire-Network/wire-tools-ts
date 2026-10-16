import type { ComponentType } from "react"

import { NestedError } from "@wireio/shared"

import type { TuiRoute } from "./TuiRoute.js"
import { useTuiNavigation } from "./TuiRouterContext.js"

/** Route → component table. */
export type TuiRouteTable = Readonly<Record<TuiRoute, ComponentType>>

/** Props of {@link TuiRouteOutlet}. */
export interface TuiRouteOutletProps {
  /** Component per route. */
  routes: TuiRouteTable
}

/**
 * Render the component of the top route.
 *
 * @param props - The route table.
 * @returns The route element.
 * @throws NestedError when the table has no component for the route.
 */
export function TuiRouteOutlet({ routes }: TuiRouteOutletProps) {
  const { router } = useTuiNavigation(),
    Route = routes[router.current]
  if (Route == null) throw new NestedError(`no component for TUI route ${router.current}`, { context: { route: router.current } })
  return <Route />
}
