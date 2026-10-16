import { QLBrand } from "@wireio/ql-shared"

import { TuiColorRole, TuiPalette } from "@wireio/ql-tool-cli/tui/index.js"

describe("TuiPalette", () => {
  it("colors every role, the brand from QLBrand", () => {
    Object.values(TuiColorRole).forEach(role => expect(TuiPalette[role].length).toBeGreaterThan(0))
    expect(TuiPalette[TuiColorRole.brand]).toBe(QLBrand.PrimaryHex)
  })

  it("keeps errors and warnings apart", () => {
    expect(TuiPalette[TuiColorRole.error]).not.toBe(TuiPalette[TuiColorRole.warning])
  })
})
