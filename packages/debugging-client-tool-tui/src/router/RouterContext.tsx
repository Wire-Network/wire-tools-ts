import React, { createContext, useCallback, useContext, useMemo, useState } from "react"
import { asOption } from "@3fv/prelude-ts"
import { RouterStack } from "./RouterStack.js"
import type { RouteMatch, RouteParams } from "./RouteTypes.js"

/**
 * Navigation API exposed via context to every descendant. Modeled as a stack
 * so Esc (single-tap) can pop one level and `push`/`replace`/`reset` cover the
 * common imperative moves.
 */
export interface RouterAPI {
  /** Full stack, root-first. `current` is the last element. */
  readonly stack: readonly RouteMatch[]
  /** Top-of-stack route (undefined only if the stack was somehow emptied). */
  readonly current: RouteMatch | undefined
  /** Convenience: `stack.length > 1`. Drives "single Esc" behavior. */
  readonly canGoBack: boolean
  /** Push a new route onto the stack. */
  push(path: string, params?: RouteParams): void
  /** Replace the top-of-stack route with a new one. */
  replace(path: string, params?: RouteParams): void
  /** Pop one level; no-op when at root. */
  pop(): void
  /** Clear the stack and seed with a single route. */
  reset(path: string, params?: RouteParams): void
}

const RouterContext = createContext<RouterAPI | null>(null)

/**
 * Grab the ambient router API. Throws when no `RouterProvider` is mounted —
 * components should never be rendered outside one.
 */
export function useRouter(): RouterAPI {
  return asOption(useContext(RouterContext)).getOrThrow(
    "useRouter called outside a RouterProvider"
  )
}

export interface RouterProviderProps {
  /** Initial path seeded into the stack (usually a required feature's route). */
  initialPath: string
  children?: React.ReactNode
}

/**
 * Owns the route-stack state and exposes `RouterAPI` via React context.
 * Mount once at the top of the Ink tree (typically in `tui.ts`). All mutation
 * logic delegates to the pure {@link RouterStack} helpers so the state machine
 * can be unit-tested without a React renderer.
 */
export function RouterProvider(props: RouterProviderProps): React.ReactElement {
  const [stack, setStack] = useState<RouteMatch[]>(() =>
    RouterStack.seed(props.initialPath)
  )

  const push = useCallback((path: string, params?: RouteParams) => {
    setStack(prev => RouterStack.push(prev, path, params))
  }, [])

  const replace = useCallback((path: string, params?: RouteParams) => {
    setStack(prev => RouterStack.replace(prev, path, params))
  }, [])

  const pop = useCallback(() => {
    setStack(prev => RouterStack.pop(prev))
  }, [])

  const reset = useCallback((path: string, params?: RouteParams) => {
    setStack(RouterStack.reset(path, params))
  }, [])

  const api = useMemo<RouterAPI>(
    () => ({
      stack,
      current: RouterStack.current(stack),
      canGoBack: stack.length > 1,
      push,
      replace,
      pop,
      reset
    }),
    [stack, push, replace, pop, reset]
  )

  return (
    <RouterContext.Provider value={api}>
      {props.children}
    </RouterContext.Provider>
  )
}

/** Exported for tests that want to read the raw context. */
export { RouterContext }
