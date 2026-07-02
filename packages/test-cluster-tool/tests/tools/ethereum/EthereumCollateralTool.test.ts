import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { EthereumCollateralTool } from "@wireio/test-cluster-tool/tools/ethereum"

describe("EthereumCollateralTool.mockErc20Address", () => {
  let deploymentsPath: string
  beforeAll(() => {
    deploymentsPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-deployments-"))
    Fs.writeFileSync(
      Path.join(deploymentsPath, "outpost-addrs.json"),
      JSON.stringify({
        MockUsdc: "0x00000000000000000000000000000000000000a1",
        MockUsdt: "0x00000000000000000000000000000000000000a2",
        OperatorRegistry: "0x00000000000000000000000000000000000000a3"
      })
    )
  })
  afterAll(() => {
    Fs.rmSync(deploymentsPath, { recursive: true, force: true })
  })

  it("resolves USDC / USDT to their deployed mock addresses", () => {
    expect(EthereumCollateralTool.mockErc20Address(deploymentsPath, "USDC")).toBe(
      "0x00000000000000000000000000000000000000a1"
    )
    expect(EthereumCollateralTool.mockErc20Address(deploymentsPath, "USDT")).toBe(
      "0x00000000000000000000000000000000000000a2"
    )
  })

  it("throws LOUDLY for a token with no deployed mock (never a silent skip)", () => {
    expect(() =>
      EthereumCollateralTool.mockErc20Address(deploymentsPath, "LIQETH")
    ).toThrow(/no deployed mock ERC-20 for LIQETH/)
  })

  it("throws when the deploy artifacts are absent entirely", () => {
    expect(() =>
      EthereumCollateralTool.mockErc20Address("/no/such/deployments", "USDC")
    ).toThrow(/outpost addresses not found/)
  })
})
