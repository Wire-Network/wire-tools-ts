import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SlugName, SysioContracts } from "@wireio/sdk-core"

describe("Steps.contracts.sysio.tokens", () => {
  it("regtoken carries the tokens::regtoken data", () => {
    const data: SysioContracts.SysioTokensRegtokenAction = {
      kind: SysioContracts.SysioTokensTokenkind.TOKEN_KIND_NATIVE,
      code: { value: SlugName.from("WIRE") },
      symbol_name: "Wire",
      description: "WIRE chain native asset",
      precision: 9,
      address: {
        kind: SysioContracts.SysioTokensChainkind.CHAIN_KIND_UNKNOWN,
        address: ""
      }
    }
    const step = Steps.contracts.sysio.tokens.planRegtoken(
      Report.Actor.Sysio,
      "register-wire-token",
      "register the WIRE native token",
      {},
      data
    )
    expect(step.actor).toBe(Report.Actor.Sysio)
    expect(step.input.kind).toBe("TokensContractSteps.RegtokenInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.precision).toBe(9)
    expect(typeof step.runner).toBe("function")
  })

  it("regctok carries the tokens::regctok chain-token binding", () => {
    const data: SysioContracts.SysioTokensRegctokAction = {
      chain_code: { value: SlugName.from("ETHEREUM") },
      token_code: { value: SlugName.from("ETH") },
      contract_addr: "",
      is_native: true
    }
    const step = Steps.contracts.sysio.tokens.planRegctok(
      Report.Actor.Sysio,
      "bind-ethereum-eth",
      "bind native ETH on the Ethereum outpost",
      {},
      data
    )
    expect(step.input.kind).toBe("TokensContractSteps.RegctokInput")
    expect(step.input.data).toBe(data)
    expect(step.input.data.is_native).toBe(true)
    expect(typeof step.runner).toBe("function")
  })
})
