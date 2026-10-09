/** Platform font stacks (no bundled fonts: every OS renders its own UI / monospace face). */
export namespace PlatformFonts {
  /** UI text. */
  export const Ui = [
    "system-ui",
    "-apple-system",
    "BlinkMacSystemFont",
    "\"Segoe UI\"",
    "Ubuntu",
    "Cantarell",
    "\"Noto Sans\"",
    "sans-serif"
  ].join(", ")
  /** Code, cells and the editor. */
  export const Monospace = [
    "ui-monospace",
    "\"SF Mono\"",
    "Menlo",
    "\"Cascadia Mono\"",
    "Consolas",
    "\"DejaVu Sans Mono\"",
    "monospace"
  ].join(", ")
  /** Base font size (px) — desktop density. */
  export const BaseSizePx = 13
}
