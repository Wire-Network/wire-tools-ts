import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { loadBar } from "@wireio/cluster-tool/tools/ethereum"

/** A syntactically-valid deployed address for the fixture map. */
const BAR_ADDRESS = "0x00000000000000000000000000000000000000b1"

describe("EthereumNodeOwnerNftTool.loadBar", () => {
  let ethereumPath: string
  let signer: ethers.Signer

  beforeAll(() => {
    // A fake wire-ethereum root carrying only the hardhat BAR artifact.
    ethereumPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-repo-"))
    const artifactDir = Path.join(
      ethereumPath,
      "artifacts",
      "contracts",
      "outpost",
      "BAR.sol"
    )
    Fs.mkdirSync(artifactDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(artifactDir, "BAR.json"),
      JSON.stringify({ abi: [] })
    )
    signer = ethers.Wallet.createRandom()
  })

  afterAll(() => {
    Fs.rmSync(ethereumPath, { recursive: true, force: true })
  })

  it("binds the artifact ABI to the deployed address from outpost-addrs", () => {
    const contract = loadBar(ethereumPath, { BAR: BAR_ADDRESS }, signer)
    expect(contract.target).toBe(BAR_ADDRESS)
  })

  it("throws LOUDLY when BAR is absent from the address map", () => {
    expect(() => loadBar(ethereumPath, {}, signer)).toThrow(
      /BAR not in outpost-addrs\.json/
    )
  })

  it("throws when the hardhat artifact is missing", () => {
    const bareRepo = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-bare-"))
    try {
      expect(() => loadBar(bareRepo, { BAR: BAR_ADDRESS }, signer)).toThrow(
        /artifact not found/
      )
    } finally {
      Fs.rmSync(bareRepo, { recursive: true, force: true })
    }
  })
})
