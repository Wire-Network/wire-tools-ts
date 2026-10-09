import type { IPCChannel } from "../../../common/index.js"
import type { NativeThemeController } from "../../theme/index.js"
import type { IPCHandlers } from "../registerIPCHandlers.js"

/** The appearance invoke channel. */
export type ThemeHandlerMap = Pick<IPCHandlers, IPCChannel.setThemeSource>

/**
 * Handler applying + persisting the appearance; `onChanged` refreshes the menu's radio items.
 *
 * @param theme - The theme controller.
 * @param onChanged - Called after the change.
 * @returns The handler.
 */
export function createThemeHandlers(theme: NativeThemeController, onChanged: () => void): ThemeHandlerMap {
  return {
    setThemeSource: async ({ source }) => {
      theme.set(source)
      onChanged()
    }
  }
}
