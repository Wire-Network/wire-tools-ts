import {
  store,
  type AppDispatch,
  type RootState
} from "../store/Store.js"
import type { Service } from "./Service.js"
import { ServiceId } from "./ServiceId.js"
import type { ServiceManager } from "./ServiceManager.js"
import { asServiceType } from "./ServiceType.js"

/**
 * Infrastructure service — exposes the redux store to other services so they
 * don't import it directly. Registered first in `tui.ts` before any feature
 * providers. Every stateful service lists `ServiceId.Redux` in `dependsOn`.
 */
export class ReduxService implements Service {
  static readonly id = ServiceId.Redux
  static readonly dependsOn: readonly string[] = []

  /** Raw store handle — prefer `dispatch` / `getState` for typed access. */
  get store(): typeof store {
    return store
  }
  /** Typed dispatch. */
  get dispatch(): AppDispatch {
    return store.dispatch
  }
  /** Current state snapshot. */
  getState(): RootState {
    return store.getState()
  }
  /** Subscribe to store changes; returns the unsubscribe thunk. */
  subscribe(listener: () => void): () => void {
    return store.subscribe(listener)
  }

  async init(_manager: ServiceManager): Promise<this> {
    return this
  }
  async start(_manager: ServiceManager): Promise<this> {
    return this
  }
  async stop(_manager: ServiceManager): Promise<this> {
    return this
  }
}

/** Static-shape check — ensures TS catches a missing static at compile time. */
export const ReduxServiceType = asServiceType(ReduxService)
