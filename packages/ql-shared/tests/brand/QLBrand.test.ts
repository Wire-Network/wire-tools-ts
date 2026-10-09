import Fs from "node:fs"
import Path from "node:path"

import { QLBrand } from "@wireio/ql-shared"

describe("QLBrand", () => {
  it("exposes the Wire brand constants", () => {
    expect(QLBrand.PrimaryHex).toBe("#2F6BFF")
    expect(QLBrand.ProductName).toBe("WIRE QL")
    expect(QLBrand.CliName).toBe("wql")
  })

  it("is sourced from the plain QLBrand.json the icon generator reads", () => {
    const document = JSON.parse(
      Fs.readFileSync(Path.join(__dirname, "..", "..", "src", "brand", "QLBrand.json"), "utf8")
    )
    expect(document).toEqual({
      primaryHex: QLBrand.PrimaryHex,
      productName: QLBrand.ProductName,
      cliName: QLBrand.CliName
    })
    expect(QLBrand.PrimaryHex).toMatch(/^#[0-9A-F]{6}$/)
  })
})
