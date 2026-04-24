import Assert from "node:assert"
import { RouteRegistry } from "./RouteRegistry.js"
import type { RouteMatch, RouteParams } from "./RouteTypes.js"

/**
 * Pure stack transitions used by `RouterProvider`. Extracted so the navigation
 * state machine can be unit-tested without a React renderer. Every function
 * takes and returns the immutable `stack: readonly RouteMatch[]` representation.
 */
export namespace RouterStack {
  /** Resolve a path + params into a `RouteMatch` via the registry. Throws on unknown path. */
  export function resolve(path: string, params: RouteParams = {}): RouteMatch {
    const route = RouteRegistry.find(path)
    Assert.ok(route, `Route not found: ${path}`)
    return { route, params }
  }

  /** Seed a one-entry stack with the given path. */
  export function seed(path: string, params?: RouteParams): RouteMatch[] {
    return [resolve(path, params)]
  }

  /** Push a new route on top. */
  export function push(
    stack: readonly RouteMatch[],
    path: string,
    params?: RouteParams
  ): RouteMatch[] {
    return [...stack, resolve(path, params)]
  }

  /** Replace top-of-stack without changing depth. */
  export function replace(
    stack: readonly RouteMatch[],
    path: string,
    params?: RouteParams
  ): RouteMatch[] {
    return [...stack.slice(0, -1), resolve(path, params)]
  }

  /** Pop one level; returns the same array (no-op) when at root. */
  export function pop(stack: readonly RouteMatch[]): RouteMatch[] {
    return stack.length > 1 ? stack.slice(0, -1) : [...stack]
  }

  /** Reset to a single-entry stack. */
  export function reset(
    path: string,
    params?: RouteParams
  ): RouteMatch[] {
    return [resolve(path, params)]
  }

  /** Top-of-stack helper. Undefined only if someone emptied the array. */
  export function current(
    stack: readonly RouteMatch[]
  ): RouteMatch | undefined {
    return stack[stack.length - 1]
  }
}
