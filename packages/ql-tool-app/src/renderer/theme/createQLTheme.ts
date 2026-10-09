import { createTheme, type Theme } from "@mui/material/styles"
import type * as Monaco from "monaco-editor"

import { QLBrand } from "@wireio/ql-shared"

import { NativeOverrides } from "./NativeOverrides.js"
import { PlatformFonts } from "./PlatformFonts.js"

/**
 * The workbench theme: CSS variables with `colorSchemeSelector: "media"`, so
 * Chromium's `prefers-color-scheme` — which follows `nativeTheme.themeSource`
 * — switches light/dark LIVE; the Wire brand blue is the primary color in both
 * schemes; platform fonts; desktop-native component overrides.
 *
 * @returns The theme.
 */
export function createQLTheme(): Theme {
  return createTheme({
    cssVariables: { colorSchemeSelector: "media" },
    colorSchemes: {
      light: { palette: { primary: { main: QLBrand.PrimaryHex } } },
      dark: { palette: { primary: { main: QLBrand.PrimaryHex } } }
    },
    typography: { fontFamily: PlatformFonts.Ui, fontSize: PlatformFonts.BaseSizePx },
    shape: { borderRadius: createQLTheme.BorderRadiusPx },
    components: NativeOverrides.components()
  })
}

/** Theme constants. */
export namespace createQLTheme {
  /** Corner radius (px) — flat, desktop-like. */
  export const BorderRadiusPx = 4
  /** Built-in Monaco base theme of the light scheme (the `wirequery` light theme inherits it). */
  export const MonacoLightTheme: Monaco.editor.BuiltinTheme = "vs"
  /** Built-in Monaco base theme of the dark scheme (the `wirequery` dark theme inherits it). */
  export const MonacoDarkTheme: Monaco.editor.BuiltinTheme = "vs-dark"
  /** Media query of the dark scheme. */
  export const DarkSchemeQuery = "(prefers-color-scheme: dark)"
}
