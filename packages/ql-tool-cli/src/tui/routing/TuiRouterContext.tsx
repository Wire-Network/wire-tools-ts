import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

import { NestedError } from "@wireio/shared"

import type { TuiRoute } from "./TuiRoute.js"
import { TuiRouter } from "./TuiRouter.js"

/** Navigation API of the running TUI. */
export interface TuiNavigation {
  /** The current router. */
  router: TuiRouter
  /** Push a route. */
  push(route: TuiRoute): void
  /** Pop back (no-op on the last route). */
  pop(): void
  /** Replace the top route. */
  replace(route: TuiRoute): void
}

const TuiRouterReactContext = createContext<TuiNavigation>(null)

/** Props of {@link TuiRouterProvider}. */
export interface TuiRouterProviderProps {
  /** The initial router (default: the workbench). */
  initial?: TuiRouter
  /** The app. */
  children?: ReactNode
}

/**
 * Hold the route stack in React state and provide navigation.
 *
 * @param props - Initial router and children.
 * @returns The provider element.
 */
export function TuiRouterProvider({ initial, children }: TuiRouterProviderProps) {
  const [router, setRouter] = useState<TuiRouter>(() => initial ?? new TuiRouter()),
    navigation = useMemo<TuiNavigation>(
      () => ({
        router,
        push: route => setRouter(current => current.push(route)),
        pop: () => setRouter(current => current.pop()),
        replace: route => setRouter(current => current.replace(route))
      }),
      [router]
    )
  return <TuiRouterReactContext.Provider value={navigation}>{children}</TuiRouterReactContext.Provider>
}

/**
 * The navigation of the running TUI.
 *
 * @returns Router + push / pop / replace.
 * @throws NestedError outside a {@link TuiRouterProvider}.
 */
export function useTuiNavigation(): TuiNavigation {
  const navigation = useContext(TuiRouterReactContext)
  if (navigation == null) throw new NestedError("useTuiNavigation called outside a TuiRouterProvider")
  return navigation
}
