import { OperatorType, TokenAmount } from "@wireio/opp-typescript-models"
import { KeyType, SlugName } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import {
  BatchOperatorUnderwritingSteps,
  SyndicationScenario
} from "@wireio/cluster-tool/flow"
import {
  ClusterBuild,
  type ClusterBuildPhase,
  outputKey
} from "@wireio/cluster-tool/orchestration"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

/** A context of three batch operators, `funded` of them funded, under a `cap`. */
function underwritingContext(funded: number, cap = 10_000_000_000n) {
  const ctx = fixtureContext()
  Constants.batchOperatorLabels(3).forEach((label, index) =>
    ctx.keyStore.setOperator({
      label,
      publicationLabel: label,
      account: `wireno.op${index}`,
      type: OperatorType.BATCH,
      wire: { type: KeyType.K1, publicKey: "PUB", privateKey: "PVT" }
    })
  )
  return {
    ...ctx,
    keyStore: ctx.keyStore,
    outputs: ctx.outputs,
    config: {
      ...ctx.config,
      batchOperatorCount: 3,
      batchOperatorUnderwriting: {
        fundedOperatorCount: funded,
        maxExposure: [
          TokenAmount.create({
            tokenCode: BigInt(SlugName.from("LIQSOL")),
            amount: cap
          })
        ]
      }
    }
  } as unknown as ReturnType<typeof fixtureContext>
}

afterEach(() => jest.restoreAllMocks())

describe("BatchOperatorUnderwritingSteps operators and cap", () => {
  it("splits the operators into the funded prefix and the unfunded rest", () => {
    const ctx = underwritingContext(1)
    expect(BatchOperatorUnderwritingSteps.batchOperatorAccounts(ctx)).toEqual([
      "wireno.op0",
      "wireno.op1",
      "wireno.op2"
    ])
    expect(BatchOperatorUnderwritingSteps.fundedOperatorAccounts(ctx)).toEqual([
      "wireno.op0"
    ])
    expect(
      BatchOperatorUnderwritingSteps.unfundedOperatorAccounts(ctx)
    ).toEqual(["wireno.op1", "wireno.op2"])
    expect(
      BatchOperatorUnderwritingSteps.unfundedOperatorAccounts(
        underwritingContext(3)
      )
    ).toEqual([])
  })

  it("reads the LIQSOL cap the daemons run with", () => {
    expect(
      BatchOperatorUnderwritingSteps.maxExposure(
        underwritingContext(1, 2_010_000_000n)
      )
    ).toBe(2_010_000_000n)
    expect(
      ClusterConfigProvider.DefaultBatchUnderwriterMaxExposure.tokenCode
    ).toBe(SyndicationScenario.TokenCode)
  })

  it("refuses a relay-only cluster", () => {
    const ctx = fixtureContext()
    expect(() =>
      BatchOperatorUnderwritingSteps.fundedOperatorAccounts(ctx)
    ).toThrow(/do not underwrite/)
    expect(() => BatchOperatorUnderwritingSteps.maxExposure(ctx)).toThrow(
      /do not underwrite/
    )
  })

  it("asserts the unfunded operators hold nothing", async () => {
    const ctx = underwritingContext(1),
      read = jest
        .spyOn(SyndicationScenario, "readBalance")
        .mockResolvedValue(0n)
    await BatchOperatorUnderwritingSteps.assertUnfundedHoldNothing(ctx)
    expect(read.mock.calls.map(([, account]) => account)).toEqual([
      "wireno.op1",
      "wireno.op2"
    ])
    read.mockResolvedValue(1n)
    await expect(
      BatchOperatorUnderwritingSteps.assertUnfundedHoldNothing(ctx)
    ).rejects.toThrow(/unfunded batch operator wireno.op1 holds LIQSOL/)
  })

  it("lists a plan's requests in issue order", () => {
    const key = (name: string) => outputKey<number>(name, name),
      plan = {
        firstRequest: key("a"),
        secondRequest: key("b"),
        parkedRequest: key("c")
      } as unknown as BatchOperatorUnderwritingSteps.Plan
    expect(
      BatchOperatorUnderwritingSteps.requestsOf(plan).map(entry => entry.name)
    ).toEqual(["a", "b", "c"])
  })
})

describe("BatchOperatorUnderwritingSteps plan and shared phases", () => {
  const Steps = BatchOperatorUnderwritingSteps

  it("mints a plan's seven output keys under its prefix and defaults its syndications", () => {
    const plan = Steps.createPlan("uwTest")
    expect(
      [
        plan.before,
        plan.firstEpoch,
        plan.firstRequest,
        plan.secondEpoch,
        plan.secondRequest,
        plan.parkedEpoch,
        plan.parkedRequest
      ].map(key => key.name)
    ).toEqual([
      "uwTest.before",
      "uwTest.firstEpoch",
      "uwTest.firstRequest",
      "uwTest.secondEpoch",
      "uwTest.secondRequest",
      "uwTest.parkedEpoch",
      "uwTest.parkedRequest"
    ])
    expect(plan).toMatchObject({
      user: Steps.DefaultUser,
      unlinked: Steps.DefaultUnlinked,
      amount: 2_000_000_001n,
      laterAmount: 500_000_000n,
      feeBps: 100
    })
    expect(Steps.createPlan("uwTest", { amount: 7n, feeBps: 0 })).toMatchObject(
      { amount: 7n, laterAmount: Steps.DefaultLaterAmount, feeBps: 0 }
    )
  })

  it("derives the pair rules and the later net credit from the plan", () => {
    const plan = Steps.createPlan("uwTest")
    expect(Steps.configOf(plan)).toMatchObject({
      chain_code: SyndicationScenario.Chain,
      token_code: SyndicationScenario.Token,
      synd_fee_bps: 100,
      window_sec: 60,
      bounty: 0
    })
    expect(Steps.configOf(plan, 240).window_sec).toBe(240)
    expect(Steps.laterNetOf(plan)).toBe(495_000_000n)
  })

  it("plans the configure, unlinked intake, park-and-link and settle phases in order", () => {
    const cluster = ClusterBuild.forContext(fixtureContext()),
      plan = Steps.createPlan("uwTest")
    Steps.planConfigureUnderwriting(cluster, plan, Steps.configOf(plan), {
      phase: "phase",
      configure: "configure",
      funded: "funded"
    })
    Steps.planUnlinkedIntake(cluster, plan)
    Steps.planParkAndLink(cluster, plan)
    Steps.planSettle(cluster, plan)
    const phases = cluster.children as unknown as readonly ClusterBuildPhase[]
    expect(
      phases.map(phase => [phase.name, phase.steps.map(step => step.name)])
    ).toEqual([
      ["ConfigureUnderwriting", ["configure-underwriting", "operators-funded"]],
      [
        "UnlinkedIntake",
        [
          "unlinked-syndication",
          "unlinked-requested",
          "unlinked-bonded",
          "unlinked-custody",
          "unlinked-released"
        ]
      ],
      ["ParkAndLink", ["parked-credit", "link-recipient", "parked-delivered"]],
      [
        "Settle",
        [
          "unlinked-approved-and-claimed",
          "operators-settled",
          "operators-active"
        ]
      ]
    ])
  })
})
