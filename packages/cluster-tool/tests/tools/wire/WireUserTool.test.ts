import { Report } from "@wireio/cluster-tool/report"
import { ClioRunner } from "@wireio/cluster-tool/clients/wire/clio/ClioRunner"
import { WireUserTool } from "@wireio/cluster-tool/tools/wire"

describe("WireUserTool atomic step factories", () => {
  it("builds separate account, policy, and funding Steps", () => {
    const create = WireUserTool.planAccountCreation(
        Report.Actor.User,
        "create-user",
        "create user",
        {},
        "swapcanary"
      ),
      policy = WireUserTool.planResourcePolicy(
        Report.Actor.User,
        "policy-user",
        "policy user",
        {},
        "swapcanary"
      ),
      funding = WireUserTool.planFunding(
        Report.Actor.Sysio,
        "fund-user",
        "fund user",
        {},
        "swapcanary",
        10n
      )

    expect(create.input.kind).toBe("WireUserTool.CreateAccountInput")
    expect(policy.input.kind).toBe("WireUserTool.AddResourcePolicyInput")
    expect(funding.input).toMatchObject({
      kind: "WireUserTool.FundInput",
      account: "swapcanary",
      amount: 10n
    })
  })

  it("names user outputs by account", () => {
    expect(WireUserTool.userOutputKey("swapcanary").name).toBe(
      "wireUser.swapcanary"
    )
    expect(WireUserTool.userOutputKey("otheruser").name).not.toBe(
      WireUserTool.userOutputKey("swapcanary").name
    )
  })

  it("rejects a non-positive funding transfer", async () => {
    await expect(
      WireUserTool.runFunding(
        null as never,
        {
          kind: "WireUserTool.FundInput",
          account: "swapcanary",
          amount: 0n
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/funding must be positive/)
  })

  it("treats an existing resource policy as an idempotent connected rerun", async () => {
    const invoke = jest.fn().mockRejectedValue(
      new Error(ClioRunner.ErrorFragment.ResourcePolicyAlreadyExists)
    )
    await expect(
      WireUserTool.runResourcePolicy(
        { wire: { invoke } } as never,
        {
          kind: "WireUserTool.AddResourcePolicyInput",
          account: "swapcanary"
        },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("propagates an unexpected resource-policy failure", async () => {
    const invoke = jest.fn().mockRejectedValue(new Error("node unavailable"))
    await expect(
      WireUserTool.runResourcePolicy(
        { wire: { invoke } } as never,
        {
          kind: "WireUserTool.AddResourcePolicyInput",
          account: "swapcanary"
        },
        new AbortController().signal
      )
    ).rejects.toThrow("node unavailable")
  })
})
