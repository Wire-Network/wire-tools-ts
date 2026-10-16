import { ActionRegistry } from "./ActionRegistry.js"
import type { AppAction } from "./AppAction.js"
import type { ContextMenuItem } from "./IPCContract.js"

/** Context-menu requests built from the {@link ActionRegistry} descriptors (no label is spelled at a call site). */
export namespace ContextMenuItems {
  /**
   * One enabled item per action, labelled from its descriptor, in the given order.
   *
   * @param actions - The actions offered.
   * @returns The items.
   */
  export function of(...actions: AppAction[]): ContextMenuItem[] {
    return actions.map(action => ({ action, label: ActionRegistry.describe(action).label, enabled: true }))
  }
}
