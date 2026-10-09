import { NestedError } from "@wireio/shared"

import { TuiRoute } from "./TuiRoute.js"

/** Immutable route stack — every operation returns a new router; the top is the visible route. */
export class TuiRouter {
  /**
   * @param stack - Routes, bottom first (at least one).
   * @throws NestedError on an empty stack or an unknown route.
   */
  constructor(readonly stack: readonly TuiRoute[] = [TuiRoute.workbench]) {
    if (stack.length === 0) throw new NestedError("a TUI route stack needs at least one route")
    stack.forEach(TuiRouter.assertRoute)
  }

  /** The visible route. */
  get current(): TuiRoute {
    return this.stack.at(-1)
  }

  /**
   * Push a route.
   *
   * @param route - The route.
   * @returns The new router.
   */
  push(route: TuiRoute): TuiRouter {
    return new TuiRouter([...this.stack, route])
  }

  /**
   * Pop the top route; a single-entry stack is returned unchanged.
   *
   * @returns The new router (or this one).
   */
  pop(): TuiRouter {
    return this.stack.length === 1 ? this : new TuiRouter(this.stack.slice(0, -1))
  }

  /**
   * Replace the top route.
   *
   * @param route - The route.
   * @returns The new router.
   */
  replace(route: TuiRoute): TuiRouter {
    return new TuiRouter([...this.stack.slice(0, -1), route])
  }

  /**
   * Assert a value is a {@link TuiRoute}.
   *
   * @param route - The candidate.
   * @throws NestedError naming the known routes.
   */
  static assertRoute(route: TuiRoute): void {
    if (!Object.values(TuiRoute).includes(route)) {
      throw new NestedError(`unknown TUI route ${String(route)}`, { context: { route, routes: Object.values(TuiRoute) } })
    }
  }
}
