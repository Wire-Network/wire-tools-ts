import { AppAction, ContextMenuItems, IPCChannel } from "../../../common/index.js"
import type { AppThunk } from "../Store.js"
import { guarded } from "./common/index.js"

/** Labels of the menu thunks' failures. */
export namespace MenuThunks {
  /** What a context menu that could not be shown reports. */
  export const ContextMenuLabel = "Showing the context menu"
}

/**
 * Pop up a native context menu of `actions` (labels from the action registry)
 * through the bridge; components never reach the bridge themselves.
 *
 * @param actions - The actions offered, in order.
 * @returns The thunk resolving to the chosen action — `AppAction.none` when
 *   dismissed or when the menu could not be shown (the failure is a notice).
 */
export function showContextMenu(...actions: AppAction[]): AppThunk<AppAction> {
  return async (dispatch, getState, services) => {
    let chosen = AppAction.none
    await guarded(MenuThunks.ContextMenuLabel, async () => {
      chosen = await services.bridge.invoke(IPCChannel.showContextMenu, { items: ContextMenuItems.of(...actions) })
    })(dispatch, getState, services)
    return chosen
  }
}
