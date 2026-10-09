import type { Components, Theme } from "@mui/material/styles"

import { PlatformFonts } from "./PlatformFonts.js"

/**
 * MUI component overrides that make the workbench read as a desktop app: no
 * ripples, no uppercase, no elevation shadows (1px dividers instead), instant
 * menus/dialogs, native-style focus rings, visible scrollbars, compact density.
 */
export namespace NativeOverrides {
  /** Tooltip open delay (ms) — desktop convention. */
  export const TooltipEnterDelayMs = 500
  /** Tab / toolbar row height (px). */
  export const CompactRowHeightPx = 32
  /** Focus ring width (px). */
  export const FocusRingWidthPx = 2

  /**
   * The overrides.
   *
   * @returns The `components` theme section.
   */
  export function components(): Components<Theme> {
    return {
      MuiButtonBase: { defaultProps: { disableRipple: true } },
      MuiButton: {
        defaultProps: { disableElevation: true, size: "small" },
        styleOverrides: { root: { textTransform: "none" } }
      },
      MuiIconButton: { defaultProps: { size: "small" } },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: ({ theme }) => ({ border: `1px solid ${theme.palette.divider}` }) }
      },
      MuiAppBar: {
        defaultProps: { elevation: 0, color: "default" },
        styleOverrides: { root: ({ theme }) => ({ borderBottom: `1px solid ${theme.palette.divider}` }) }
      },
      MuiMenu: { defaultProps: { transitionDuration: 0 } },
      MuiPopover: { defaultProps: { transitionDuration: 0 } },
      MuiDialog: { defaultProps: { transitionDuration: 0 } },
      MuiTooltip: { defaultProps: { enterDelay: TooltipEnterDelayMs } },
      MuiTable: { defaultProps: { size: "small" } },
      MuiTableCell: {
        defaultProps: { size: "small" },
        styleOverrides: { root: { fontFamily: PlatformFonts.Monospace, whiteSpace: "nowrap" } }
      },
      MuiTab: {
        styleOverrides: { root: { minHeight: CompactRowHeightPx, textTransform: "none" } }
      },
      MuiTabs: { styleOverrides: { root: { minHeight: CompactRowHeightPx } } },
      MuiListItemButton: { defaultProps: { dense: true } },
      MuiTextField: { defaultProps: { size: "small" } },
      MuiSelect: { defaultProps: { size: "small" } },
      MuiCssBaseline: {
        styleOverrides: theme => ({
          ":root": { colorScheme: "light dark" },
          body: {
            scrollbarColor: `${theme.palette.text.disabled} transparent`,
            userSelect: "none"
          },
          "*:focus-visible": {
            outline: `${FocusRingWidthPx}px solid ${theme.palette.primary.main}`,
            outlineOffset: -FocusRingWidthPx
          }
        })
      }
    }
  }
}
