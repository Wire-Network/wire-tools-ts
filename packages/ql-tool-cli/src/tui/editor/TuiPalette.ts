import { QLBrand } from "@wireio/ql-shared"

/** What a TUI color means (identity enum). */
export enum TuiColorRole {
  /** Brand: focused borders, titles, the active tab. */
  brand = "brand",
  /** Unfocused borders. */
  muted = "muted",
  /** Errors and failed runs. */
  error = "error",
  /** Warnings. */
  warning = "warning",
  /** Find-in-results hits. */
  findHit = "findHit"
}

/** The ONE TUI palette: Ink color per role (the lexer's colors are {@link HighlightColors}). */
export const TuiPalette: Readonly<Record<TuiColorRole, string>> = {
  [TuiColorRole.brand]: QLBrand.PrimaryHex,
  [TuiColorRole.muted]: "gray",
  [TuiColorRole.error]: "red",
  [TuiColorRole.warning]: "yellow",
  [TuiColorRole.findHit]: "yellow"
}
