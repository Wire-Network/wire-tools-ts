import { SysioContracts } from "@wireio/sdk-core"

import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"

import { fixtureContext } from "../../../../config/clusterBuildContextFixture.js"

const VoteData: SysioContracts.SysioChalgVotedisputeAction = {
  owner: "voter1",
  dispute_id: 42,
  chosen_checksum: "canonical-checksum"
}

describe("Steps.contracts.sysio.chalg", () => {
  it("votedispute carries generated action data and binds the canonical runner", () => {
    const step = Steps.contracts.sysio.chalg.planVotedispute(
      Report.Actor.User,
      "vote-voter1",
      "vote for the canonical candidate",
      {},
      VoteData
    )

    expect(step.input).toEqual({
      kind: "ChalgContractSteps.VotedisputeInput",
      data: VoteData
    })
    expect(step.runner).toBe(Steps.contracts.sysio.chalg.runVotedispute)
  })

  it("votedispute signs as the Tier-1 owner", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(
        SysioContracts.SysioContractName.chalg
      ),
      invoke = jest
        .spyOn(contract.actions.votedispute, "invoke")
        .mockResolvedValue(undefined)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)

    await Steps.contracts.sysio.chalg.runVotedispute(
      ctx,
      { kind: "ChalgContractSteps.VotedisputeInput", data: VoteData },
      new AbortController().signal
    )

    expect(invoke).toHaveBeenCalledWith(VoteData, {
      authorization: [{ actor: VoteData.owner, permission: "active" }]
    })
  })

  it("votedispute performs no write when pre-aborted", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(
        SysioContracts.SysioContractName.chalg
      ),
      invoke = jest
        .spyOn(contract.actions.votedispute, "invoke")
        .mockResolvedValue(undefined),
      controller = new AbortController()
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
    controller.abort()

    await expect(
      Steps.contracts.sysio.chalg.runVotedispute(
        ctx,
        { kind: "ChalgContractSteps.VotedisputeInput", data: VoteData },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(invoke).not.toHaveBeenCalled()
  })
})
