import React, { useContext } from "react"
import { asOption } from "@3fv/prelude-ts"
import type { Service } from "./Service.js"
import { ServiceManager } from "./ServiceManager.js"

/**
 * React Context exposing the `ServiceManager` to descendants. Rendered once by
 * `tui.ts` wrapping the Redux `Provider`. Null default so `useServiceManager`
 * can throw a clear error when consumed outside the provider.
 */
export const ServiceManagerContext = React.createContext<ServiceManager | null>(
  null
)

/**
 * Grab the ambient `ServiceManager`.
 * Throws when no `ServiceManagerProvider` is mounted above the caller.
 */
export function useServiceManager(): ServiceManager {
  return asOption(useContext(ServiceManagerContext)).getOrThrow(
    "useServiceManager called outside a ServiceManagerContext.Provider"
  )
}

/**
 * Fetch a single booted service by id.
 *
 * @param id service id (use `ServiceId` enum members)
 * @return service instance, typed at the call site
 */
export function useService<T extends Service>(id: string): T {
  return useServiceManager().get<T>(id)
}

/**
 * Fetch multiple services in one call. Preserves tuple typing at call sites —
 * pass the `id` strings in the desired order, then assert the return type.
 */
export function useServices<T extends readonly Service[]>(
  ...ids: { [K in keyof T]: string }
): T {
  const manager = useServiceManager()
  return ids.map(id => manager.get(id)) as unknown as T
}

/** Provider props — expose the manager so tests can inject a mock. */
export interface ServiceManagerProviderProps {
  manager: ServiceManager
  children?: React.ReactNode
}

/** Thin JSX wrapper over `ServiceManagerContext.Provider`. */
export function ServiceManagerProvider(
  props: ServiceManagerProviderProps
): React.ReactElement {
  return (
    <ServiceManagerContext.Provider value={props.manager}>
      {props.children}
    </ServiceManagerContext.Provider>
  )
}
