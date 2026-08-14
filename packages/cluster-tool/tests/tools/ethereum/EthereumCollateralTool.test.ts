import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { EthereumCollateralTool } from "@wireio/cluster-tool/tools/ethereum"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

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
    Fs.writeFileSync(
      Path.join(deploymentsPath, "liqeth-addrs.json"),
      JSON.stringify({
        LiqEthToken: "0x00000000000000000000000000000000000000a4"
      })
    )
  })
  afterAll(() => {
    Fs.rmSync(deploymentsPath, { recursive: true, force: true })
  })

  it("resolves USDC / USDT to their deployed mock addresses", () => {
    expect(
      EthereumCollateralTool.mockErc20Address(deploymentsPath, "USDC")
    ).toBe("0x00000000000000000000000000000000000000a1")
    expect(
      EthereumCollateralTool.mockErc20Address(deploymentsPath, "USDT")
    ).toBe("0x00000000000000000000000000000000000000a2")
  })

  it("resolves real LIQETH from its dedicated deployment artifact", () => {
    expect(
      EthereumCollateralTool.mockErc20Address(deploymentsPath, "LIQETH")
    ).toBe("0x00000000000000000000000000000000000000a4")
  })

  it("throws LOUDLY for an unconfigured token (never a silent skip)", () => {
    expect(() =>
      EthereumCollateralTool.mockErc20Address(deploymentsPath, "DAI")
    ).toThrow(/no deployed ERC-20 for DAI/)
  })

  it("throws when the deploy artifacts are absent entirely", () => {
    expect(() =>
      EthereumCollateralTool.mockErc20Address("/no/such/deployments", "USDC")
    ).toThrow(/outpost addresses not found/)
  })
})

describe("EthereumCollateralTool.planNonNativeDeposit", () => {
  it("captures the full typed input and binds the named runner", () => {
    const step = EthereumCollateralTool.planNonNativeDeposit(
      Report.Actor.Underwriter,
      "deposit-usdc",
      "Underwriter bonds USDC collateral",
      {},
      "uwrit.a",
      2n,
      7n,
      3n,
      OperatorType.UNDERWRITER,
      1_000_000n
    )
    expect(step.input).toEqual({
      kind: "EthereumCollateralTool.DepositNonNativeInput",
      operatorLabel: "uwrit.a",
      chainCode: 2n,
      tokenCode: 7n,
      reserveCode: 3n,
      operatorType: OperatorType.UNDERWRITER,
      amount: 1_000_000n
    })
    expect(step.runner).toBe(EthereumCollateralTool.runNonNativeDeposit)
  })

  it("runner rejects a non-positive amount before touching any client", async () => {
    // The amount guard fires before any client getter is touched.
    const ctx = fixtureContext()
    await expect(
      EthereumCollateralTool.runNonNativeDeposit(
        ctx,
        {
          kind: "EthereumCollateralTool.DepositNonNativeInput",
          operatorLabel: "uwrit.a",
          chainCode: 2n,
          tokenCode: 7n,
          reserveCode: 3n,
          operatorType: OperatorType.UNDERWRITER,
          amount: 0n
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/amount must be positive/)
  })
})
