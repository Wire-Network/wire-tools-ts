import { dialog, type BrowserWindow } from "electron"

import {
  DialogOutcome,
  type DialogResult,
  type OpenDialogRequest,
  type SaveDialogRequest
} from "../../common/index.js"

/** Native open/save dialogs resolving to a discriminated {@link DialogResult} (no path on cancel). */
export namespace NativeDialogs {
  /** Filter name shown for the requested extensions. */
  export const FilterName = "Files"

  /**
   * Native open-file dialog.
   *
   * @param window - Owner window.
   * @param request - Title and extensions.
   * @returns The chosen file, or cancelled.
   */
  export async function showOpen(window: BrowserWindow, request: OpenDialogRequest): Promise<DialogResult> {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: request.title,
      properties: ["openFile"],
      filters: [{ name: FilterName, extensions: request.extensions }]
    })
    return canceled || filePaths.length === 0
      ? { outcome: DialogOutcome.cancelled }
      : { outcome: DialogOutcome.selected, filePath: filePaths[0] }
  }

  /**
   * Native save-file dialog.
   *
   * @param window - Owner window.
   * @param request - Title, suggested name and extensions.
   * @returns The chosen file, or cancelled.
   */
  export async function showSave(window: BrowserWindow, request: SaveDialogRequest): Promise<DialogResult> {
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: request.title,
      defaultPath: request.defaultName,
      filters: [{ name: FilterName, extensions: request.extensions }]
    })
    return canceled || filePath == null || filePath.length === 0
      ? { outcome: DialogOutcome.cancelled }
      : { outcome: DialogOutcome.selected, filePath }
  }
}
