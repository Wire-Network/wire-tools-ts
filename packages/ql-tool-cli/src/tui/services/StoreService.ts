import { ConnectionActions } from "../store/index.js"
import type { TuiService, TuiServiceStartContext } from "./TuiService.js"
import { TuiServiceId } from "./TuiServiceId.js"

/** Owns the store's boot state: seeds the active connection before any other service starts. */
export class StoreService implements TuiService {
  /** Service id. */
  readonly id = TuiServiceId.store
  /** No dependencies (every other service depends on it). */
  readonly dependsOn: readonly TuiServiceId[] = []

  /**
   * Seed the boot profile.
   *
   * @param context - Store and boot profile.
   */
  async start(context: TuiServiceStartContext): Promise<void> {
    context.store.dispatch(ConnectionActions.profileSelected(context.profile))
  }

  /** Nothing to release (the store outlives the services). */
  async stop(): Promise<void> {
    // the store is owned by runTui and outlives every service
  }
}
