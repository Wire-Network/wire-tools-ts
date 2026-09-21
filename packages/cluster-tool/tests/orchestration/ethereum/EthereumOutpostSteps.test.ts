import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { OperatorType } from "@wireio/opp-typescript-models"

import { fixtureOperatorAccount } from "../outputs/operatorAccountFixture.js"

describe("Steps.ethereumOutpost.deploy", () => {
  it("builds an input-less deploy step with a runner", () => {
    const step = Steps.ethereumOutpost.planDeploy(
      Report.Actor.EthereumOutpost,
      "deploy-ethereum-outpost",
      "deploy the Ethereum outpost",
      {}
    )
    expect(step.actor).toBe(Report.Actor.EthereumOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})

describe("Steps.ethereumOutpost.resolveInitialOperatorGroups", () => {
  it("maps every depot schedule group to Ethereum addresses in schedule order", () => {
    const fixtures = [
      fixtureOperatorAccount("batchop.a", OperatorType.BATCH, "wireno.alpha"),
      fixtureOperatorAccount("batchop.b", OperatorType.BATCH, "wireno.bravo"),
      fixtureOperatorAccount("batchop.c", OperatorType.BATCH, "wireno.charlie")
    ],
      operators = fixtures.map((operator, index) => ({
        ...operator,
        ethereum: {
          ...operator.ethereum,
          address: `0x${String(index + 1).padStart(40, "0")}`
        }
      }))
    const groups = Steps.ethereumOutpost.resolveInitialOperatorGroups(operators, [
      ["wireno.charlie", "wireno.alpha"],
      ["wireno.bravo"]
    ])

    expect(groups).toEqual([
      [operators[2].ethereum.address, operators[0].ethereum.address],
      [operators[1].ethereum.address]
    ])
  })

  it("rejects schedule members missing from the provisioned batch roster", () => {
    const operators = [
      fixtureOperatorAccount("batchop.a", OperatorType.BATCH, "wireno.alpha")
    ]
    expect(() =>
      Steps.ethereumOutpost.resolveInitialOperatorGroups(operators, [["wireno.ghost"]])
    ).toThrow(/wireno\.ghost.*not found among provisioned batch operators/)
  })

  it("rejects empty schedules and groups", () => {
    expect(() => Steps.ethereumOutpost.resolveInitialOperatorGroups([], [])).toThrow(
      /schedule is empty/
    )
    expect(() => Steps.ethereumOutpost.resolveInitialOperatorGroups([], [[]])).toThrow(
      /schedule group 0 is empty/
    )
  })
})
