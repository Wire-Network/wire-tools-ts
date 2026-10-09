/**
 * @jest-environment jsdom
 */
import Fs from "node:fs"
import Path from "node:path"

import { ThemeProvider } from "@mui/material/styles"
import { render } from "@testing-library/react"

import { WireMark, WireMarkIcon } from "@wireio/ql-tool-app/renderer/components/brand/WireMarkIcon"
import { createQLTheme } from "@wireio/ql-tool-app/renderer/theme"

/** The brand asset the icon must match. */
const MarkFile = Path.join(__dirname, "..", "..", "..", "..", "resources", "assets", "brand", "wire-mark.svg")

describe("WireMarkIcon", () => {
  it("path data and viewBox equal the committed brand SVG", () => {
    const svg = Fs.readFileSync(MarkFile, "utf8")
    expect(/ d="([^"]+)"/.exec(svg)[1]).toBe(WireMark.PathData)
    expect(/viewBox="([^"]+)"/.exec(svg)[1]).toBe(WireMark.ViewBox)
  })

  it("renders the mark with its accessible title", () => {
    const { container, getByTitle } = render(
      <ThemeProvider theme={createQLTheme()}>
        <WireMarkIcon whiteInDark />
      </ThemeProvider>
    )
    expect(getByTitle(WireMark.Title)).toBeInTheDocument()
    expect(container.querySelector("path").getAttribute("d")).toBe(WireMark.PathData)
  })
})
