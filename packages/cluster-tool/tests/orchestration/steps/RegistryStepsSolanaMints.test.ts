import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { SlugName } from "@wireio/sdk-core"
import { Steps } from "@wireio/cluster-tool/orchestration"

const MintsFilename = "sol-mock-mints.json"
const UsdcMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
const Decimals = 6
const UnknownCode = 12_345

describe("Steps.registry.readSolanaMints", () => {
  let directory: string

  beforeEach(() => {
    directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "registry-mints-"))
  })

  afterEach(() => {
    Fs.rmSync(directory, { recursive: true, force: true })
  })

  it("returns an empty map when sol-mock-mints.json is absent (launch policy: nothing provisioned)", () => {
    expect(
      Steps.registry.readSolanaMints(Path.join(directory, MintsFilename))
    ).toEqual({})
  })

  it("maps persisted slug codes back to codenames and ignores unknown codes", () => {
    const file = Path.join(directory, MintsFilename)
    Fs.writeFileSync(
      file,
      JSON.stringify([
        { code: SlugName.from("USDC"), mint: UsdcMint, decimals: Decimals },
        { code: UnknownCode, mint: UsdcMint, decimals: Decimals }
      ])
    )
    expect(Steps.registry.readSolanaMints(file)).toEqual({ USDC: UsdcMint })
  })
})
