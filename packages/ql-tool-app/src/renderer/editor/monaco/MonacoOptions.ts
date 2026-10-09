import type * as Monaco from "monaco-editor"
import useMediaQuery from "@mui/material/useMediaQuery"

import { createQLTheme, PlatformFonts } from "../../theme/index.js"
import { WireQueryLanguage } from "./wireQueryLanguage.js"

/** The options every Monaco editor of the workbench shares (query editor, JSON view). */
export namespace MonacoOptions {
  /** Platform monospace, desktop density, no minimap, layout following the container. */
  export const base: Monaco.editor.IStandaloneEditorConstructionOptions = {
    minimap: { enabled: false },
    fontFamily: PlatformFonts.Monospace,
    fontSize: PlatformFonts.BaseSizePx,
    automaticLayout: true,
    scrollBeyondLastLine: false
  }
}

/**
 * The Monaco theme of the OS color scheme (the `wirequery` light / dark theme), following it live.
 *
 * @returns The theme name.
 */
export function useMonacoTheme(): string {
  return WireQueryLanguage.themeOf(useMediaQuery(createQLTheme.DarkSchemeQuery))
}
