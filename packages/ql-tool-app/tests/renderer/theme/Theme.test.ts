import type { CssVarsTheme } from "@mui/material/styles"

import { QLBrand } from "@wireio/ql-shared"

import { NativeOverrides, PlatformFonts, createQLTheme } from "@wireio/ql-tool-app/renderer/theme"

describe("createQLTheme", () => {
  // createTheme with cssVariables returns the CSS-variables theme (colorSchemes populated).
  const theme = createQLTheme() as unknown as CssVarsTheme & ReturnType<typeof createQLTheme>

  it("uses the Wire brand blue as primary in both schemes", () => {
    expect(QLBrand.PrimaryHex).toBe("#2F6BFF")
    expect(theme.colorSchemes.light.palette.primary.main).toBe(QLBrand.PrimaryHex)
    expect(theme.colorSchemes.dark.palette.primary.main).toBe(QLBrand.PrimaryHex)
  })

  it("the dark scheme carries dark tokens; the scheme follows the media query", () => {
    expect(theme.colorSchemes.dark.palette.mode).toBe("dark")
    expect(theme.colorSchemes.light.palette.mode).toBe("light")
    expect(createQLTheme.DarkSchemeQuery).toBe("(prefers-color-scheme: dark)")
  })

  it("system fonts and the native overrides are installed", () => {
    expect(theme.typography.fontFamily).toBe(PlatformFonts.Ui)
    expect(theme.components.MuiButtonBase.defaultProps).toEqual({ disableRipple: true })
    expect(theme.components.MuiTableCell.styleOverrides).toEqual({
      root: { fontFamily: PlatformFonts.Monospace, whiteSpace: "nowrap" }
    })
  })
})

describe("NativeOverrides / PlatformFonts", () => {
  it("disable elevation and transitions; no uppercase buttons", () => {
    const components = NativeOverrides.components()
    expect(components.MuiPaper.defaultProps).toEqual({ elevation: 0 })
    expect(components.MuiDialog.defaultProps).toEqual({ transitionDuration: 0 })
    expect(components.MuiButton.styleOverrides).toEqual({ root: { textTransform: "none" } })
  })

  it("font stacks bundle no web font and end with a generic family", () => {
    expect(PlatformFonts.Ui.endsWith("sans-serif")).toBe(true)
    expect(PlatformFonts.Monospace.endsWith("monospace")).toBe(true)
  })
})
