import BrandDocument from "./QLBrand.json"

/**
 * WIRE QL branding — the ONE source is `QLBrand.json` (also read directly by the
 * app-icon generator script, so it must stay plain JSON). Consumed by the TUI
 * header, the GUI theme and the CLI `scriptName`.
 */
export namespace QLBrand {
  /** Brand blue of the Wire mark (docs.wire.network `text-blue`); changing it recolors every surface and the icons. */
  export const PrimaryHex: string = BrandDocument.primaryHex
  /** Human-facing product name. */
  export const ProductName: string = BrandDocument.productName
  /** Name of the CLI executable. */
  export const CliName: string = BrandDocument.cliName
}
