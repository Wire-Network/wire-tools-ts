import { createContext, useContext, type ReactNode } from "react"

import { NestedError } from "@wireio/shared"

import type { TuiService } from "./TuiService.js"
import type { TuiServiceId } from "./TuiServiceId.js"
import type { TuiServiceRegistry } from "./TuiServiceRegistry.js"

/** The registry of the running TUI (null outside {@link TuiServiceProvider}). */
const TuiServiceReactContext = createContext<TuiServiceRegistry>(null)

/** Props of {@link TuiServiceProvider}. */
export interface TuiServiceProviderProps {
  /** The started registry. */
  registry: TuiServiceRegistry
  /** The app. */
  children?: ReactNode
}

/**
 * Provide the service registry to the component tree.
 *
 * @param props - Registry and children.
 * @returns The provider element.
 */
export function TuiServiceProvider({ registry, children }: TuiServiceProviderProps) {
  return <TuiServiceReactContext.Provider value={registry}>{children}</TuiServiceReactContext.Provider>
}

/**
 * A service of the running TUI.
 *
 * @param id - The service id.
 * @returns The service, typed by the caller.
 * @throws NestedError outside a {@link TuiServiceProvider}.
 */
export function useTuiService<T extends TuiService>(id: TuiServiceId): T {
  return useTuiServiceRegistry().get<T>(id)
}

/**
 * The registry of the running TUI.
 *
 * @returns The registry.
 * @throws NestedError outside a {@link TuiServiceProvider}.
 */
export function useTuiServiceRegistry(): TuiServiceRegistry {
  const registry = useContext(TuiServiceReactContext)
  if (registry == null) throw new NestedError("useTuiServiceRegistry called outside a TuiServiceProvider")
  return registry
}
