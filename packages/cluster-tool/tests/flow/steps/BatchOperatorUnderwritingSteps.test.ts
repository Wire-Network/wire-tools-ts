import { OperatorType, TokenAmount } from "@wireio/opp-typescript-models"
import { KeyType, SlugName, SysioContracts } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import {
  BatchOperatorUnderwritingSteps,
  SyndicationScenario
} from "@wireio/cluster-tool/flow"
import {
  ClusterBuild,
  type ClusterBuildPhase,
  type ClusterBuildStep,
  outputKey,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaLiqSyndicationTool } from "@wireio/cluster-tool/tools/solana"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { bondRequestRow, bondRow, syndEnvelopeRow } from "../../tools/wire/syndicationRowFixture.js"

/** A context of three batch operators, `funded` of them funded, under a `cap`. */
function underwritingContext(funded: number, cap = 10_000_000_000n) {
  const ctx = fixtureContext()
  Constants.batchOperatorLabels(3).forEach((label, index) =>
    ctx.keyStore.setOperator({
      label,
      publicationLabel: label,
      account: `acct.op${index}`,
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
      "acct.op0",
      "acct.op1",
      "acct.op2"
    ])
    expect(BatchOperatorUnderwritingSteps.fundedOperatorAccounts(ctx)).toEqual([
      "acct.op0"
    ])
    expect(
      BatchOperatorUnderwritingSteps.unfundedOperatorAccounts(ctx)
    ).toEqual(["acct.op1", "acct.op2"])
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

  it("selects the token's own cap and refuses an uncovered token", () => {
    const ctx = underwritingContext(1)
    ctx.config.batchOperatorUnderwriting.maxExposure.push(
      TokenAmount.create({
        tokenCode: BigInt(SlugName.from("LIQETH")),
        amount: 3_000_000_000n
      })
    )
    expect(BatchOperatorUnderwritingSteps.maxExposure(ctx, "LIQETH")).toBe(
      3_000_000_000n
    )
    expect(BatchOperatorUnderwritingSteps.maxExposure(ctx, "LIQSOL")).toBe(
      10_000_000_000n
    )
    expect(() =>
      BatchOperatorUnderwritingSteps.maxExposure(ctx, "UNKNOWN")
    ).toThrow(/no UNKNOWN exposure cap/)
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
      "acct.op1",
      "acct.op2"
    ])
    read.mockResolvedValue(1n)
    await expect(
      BatchOperatorUnderwritingSteps.assertUnfundedHoldNothing(ctx)
    ).rejects.toThrow(/unfunded batch operator acct.op1 holds LIQSOL/)
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
      desynd_fee_flat: 100_000,
      min_desyndicate: 50_000_000,
      window_sec: 60,
      bounty: 0,
      custody_shortfall_bps: 0
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

describe("BatchOperatorUnderwritingSteps.shortestRetainingEpochSec", () => {
  /** Seconds the statement outlives the later bond at `epochSec`, less the headroom. */
  function marginSec(epochSec: number, windowFixedSec: number, trailingSec: number, headroomEpochs: number): number {
    return (
      (BatchOperatorUnderwritingSteps.SolanaRetainedEnvelopeEpochs - headroomEpochs) * epochSec -
      (epochSec + windowFixedSec + trailingSec)
    )
  }

  it.each([
    [529, 45, 1, 72],
    [529, 45, 0, 64],
    [100, 0, 1, 13],
    [0, 0, 1, 0]
  ])("window less one epoch %ss, %ss of passes, %s epoch(s) of headroom: %ss", (windowFixedSec, trailingSec, headroomEpochs, expected) => {
    const epochSec = BatchOperatorUnderwritingSteps.shortestRetainingEpochSec(windowFixedSec, trailingSec, headroomEpochs)
    expect(epochSec).toBe(expected)
    expect(marginSec(epochSec, windowFixedSec, trailingSec, headroomEpochs)).toBeGreaterThanOrEqual(0)
    if (epochSec > 0) expect(marginSec(epochSec - 1, windowFixedSec, trailingSec, headroomEpochs)).toBeLessThan(0)
  })

  it("refuses the shortest depot epoch for a window about the log's own depth", () => {
    const windowFixedSec = 529
    expect(marginSec(SyndicationScenario.EpochDurationSec, windowFixedSec, 45, 1)).toBeLessThan(0)
    expect(BatchOperatorUnderwritingSteps.shortestRetainingEpochSec(windowFixedSec, 45, 1)).toBeGreaterThan(
      SyndicationScenario.EpochDurationSec
    )
  })
})

/**
 * The settlement verifies both plugin-underwriting flows share, against one funded
 * operator whose cap is exactly the first request's coverage.
 */
describe("BatchOperatorUnderwritingSteps settlement verifies", () => {
  const plan = BatchOperatorUnderwritingSteps.createPlan("settlement"),
    covered = SyndicationScenario.coveredOf(plan.amount),
    funded = "acct.op0",
    signal = new AbortController().signal

  /** The context the verifies run in, with the plan's balances and requests recorded. */
  function settlementContext(): ReturnType<typeof fixtureContext> {
    const ctx = underwritingContext(1, covered)
    ctx.outputs.set(plan.before, { holder: 0n, operators: 100n, fees: 0n })
    ctx.outputs.set(plan.firstRequest, 1)
    ctx.outputs.set(plan.secondRequest, 2)
    ctx.outputs.set(plan.firstEpoch, 4)
    ctx.outputs.set(plan.secondEpoch, 6)
    return ctx
  }

  /** Run a verify Step. */
  function run(step: ClusterBuildStep, ctx: ReturnType<typeof fixtureContext>): Promise<void> {
    return step.runner(ctx, step.input, signal)
  }

  describe("planVerifyBonded", () => {
    const step = BatchOperatorUnderwritingSteps.planVerifyBonded(
      Report.Actor.Underwriter,
      "first-bonded",
      "the first request is bonded by funded operators only, within the cap",
      {},
      plan,
      plan.firstRequest
    )

    /** Serve the first request fully bonded by `first`, and `second` for the later request. */
    function serveBonds(
      first: SysioContracts.SysioBondBondRowType[],
      second: SysioContracts.SysioBondBondRowType[] = []
    ): void {
      jest
        .spyOn(WireSyndicationTool, "readRequest")
        .mockResolvedValue(
          bondRequestRow(covered.toString(), covered.toString(), SysioContracts.SysioBondRequestState.BONDED, 1)
        )
      jest
        .spyOn(WireSyndicationTool, "readBonds")
        .mockImplementation(async (_ctx, requestId) => (Number(requestId) === 1 ? first : second))
    }

    it("passes when the funded operator alone bonds the whole coverage", async () => {
      serveBonds([bondRow(1, funded, covered.toString())])
      await run(step, settlementContext())
    })

    it("refuses a bond by an operator that is not funded", async () => {
      serveBonds([bondRow(1, "acct.op1", covered.toString())])
      await expect(run(step, settlementContext())).rejects.toThrow(/not a funded batch operator/)
    })

    it("refuses unpaid bonds that together exceed the operator's cap", async () => {
      serveBonds([bondRow(1, funded, covered.toString())], [bondRow(2, funded, "1")])
      await expect(run(step, settlementContext())).rejects.toThrow(/above its \d+ cap/)
    })
  })

  describe("planVerifyFirstRelease", () => {
    const step = BatchOperatorUnderwritingSteps.planVerifyFirstRelease(
      Report.Actor.Sysio,
      "first-released",
      "exact fee and linked credit, including any second release after cap recovery",
      {},
      plan
    )

    /** Serve the first envelope released in full, the second `secondReleased`, and the matching balances. */
    function serveRelease(secondReleased: bigint): void {
      const firstFee = SyndicationScenario.feeOf(plan.amount, plan.feeBps),
        secondFee = SyndicationScenario.feeOf(secondReleased, plan.feeBps),
        released = (amount: bigint, released: bigint): SysioContracts.SysioSyndEnvelopeRowType => ({
          ...syndEnvelopeRow(SyndicationScenario.Chain, SyndicationScenario.Token, 0, SysioContracts.SysioSyndEnvelopeState.DONE),
          synd_total: amount.toString(),
          released: released.toString()
        })
      jest
        .spyOn(SyndicationScenario, "readEnvelope")
        .mockImplementation(async (_ctx, key) =>
          key === plan.firstEpoch ? released(plan.amount, plan.amount) : released(plan.laterAmount, secondReleased)
        )
      jest
        .spyOn(SyndicationScenario, "readBalance")
        .mockResolvedValue(plan.amount - firstFee + secondReleased - secondFee)
      jest.spyOn(SyndicationScenario, "readFees").mockResolvedValue(firstFee + secondFee)
    }

    it.each([
      ["nothing", 0n],
      ["all of it", plan.laterAmount]
    ])("accepts a second envelope that released %s alongside the first", async (_label, secondReleased) => {
      serveRelease(secondReleased)
      await run(step, settlementContext())
    })

    it("refuses a second envelope released in part", async () => {
      serveRelease(1n)
      await expect(run(step, settlementContext())).rejects.toThrow(/neither nothing nor all/)
    })
  })
})

describe("BatchOperatorUnderwritingSteps waits on outpost -> depot intake add no traffic", () => {
  /** The epoch-state read and the traffic push, spied on. */
  interface TrafficSpies {
    /** `EpochContractSteps.readEpochStates`. */
    readonly states: jest.SpyInstance
    /** `EpochContractSteps.runNotetraffic`. */
    readonly push: jest.SpyInstance
  }

  /**
   * Spy on the epoch-state read and the traffic push: the outpost's backlog report drives these
   * waits, so neither may run.
   */
  function watchTraffic(): TrafficSpies {
    return {
      states: jest.spyOn(Steps.contracts.sysio.epoch, "readEpochStates"),
      push: jest.spyOn(Steps.contracts.sysio.epoch, "runNotetraffic").mockResolvedValue(undefined)
    }
  }

  it("the recorded-request wait reads on until the envelope's request is issued, pushing no traffic", async () => {
    const { states, push } = watchTraffic(),
      epoch = outputKey<number>("test.recorded.epoch", "epoch"),
      request = outputKey<SysioContracts.SysioBondApproveAction["request_id"]>("test.recorded.request", "request"),
      issued = {
        ...syndEnvelopeRow(Constants.ETHEREUM_CHAIN_CODENAME, "LIQETH", 7, SysioContracts.SysioSyndEnvelopeState.REQUESTED),
        synd_total: "5",
        request_id: 11
      },
      step = BatchOperatorUnderwritingSteps.planVerifyRecorded(
        Report.Actor.Sysio,
        "recorded",
        "recorded",
        {},
        5n,
        null,
        epoch,
        request,
        Constants.ETHEREUM_CHAIN_CODENAME,
        "LIQETH"
      ),
      ctx = fixtureContext()
    // The first read finds nothing; the second finds the envelope's request issued.
    const read = jest
      .spyOn(WireSyndicationTool, "readEnvelopes")
      .mockResolvedValueOnce([])
      .mockResolvedValue([issued] as never)
    await step.runner(ctx, null, new AbortController().signal)
    expect(read).toHaveBeenCalledTimes(2)
    expect(ctx.outputs.assert(epoch)).toBe(7)
    expect(push).not.toHaveBeenCalled()
    expect(states).not.toHaveBeenCalled()
  })

  it("the settled-custody read reads on while a custody attestation is in flight, pushing no traffic", async () => {
    const { states, push } = watchTraffic(),
      state = { yieldAccumulatedLiqsol: 0n, liqYieldReported: 0n, liqSequence: 3n },
      attestation = { type: 0, sequence: 3n, amount: 1n, totalSyndicated: 1n }
    jest.spyOn(SolanaLiqSyndicationTool, "readLiqYieldState").mockResolvedValue(state as never)
    const attestations = jest
      .spyOn(SyndicationScenario, "readCustodyAttestations")
      .mockResolvedValueOnce([])
      .mockResolvedValue([attestation] as never)
    jest.spyOn(SolanaLiqSyndicationTool, "readPoolBalance").mockResolvedValue(9n)
    await expect(
      BatchOperatorUnderwritingSteps.readSettledCustody(fixtureContext(), "custody")
    ).resolves.toEqual({ pool: 9n, attestations: [attestation] })
    expect(attestations).toHaveBeenCalledTimes(2)
    expect(push).not.toHaveBeenCalled()
    expect(states).not.toHaveBeenCalled()
  })

  it("the settled-custody read waits out yield claimed but not yet reported", async () => {
    const { push } = watchTraffic(),
      attestation = { type: 0, sequence: 4n, amount: 1n, totalSyndicated: 1n },
      unreported = { yieldAccumulatedLiqsol: 5n, liqYieldReported: 0n, liqSequence: 3n },
      reported = { yieldAccumulatedLiqsol: 5n, liqYieldReported: 5n, liqSequence: 4n }
    const yieldState = jest
      .spyOn(SolanaLiqSyndicationTool, "readLiqYieldState")
      .mockResolvedValueOnce(unreported as never)
      .mockResolvedValue(reported as never)
    jest.spyOn(SyndicationScenario, "readCustodyAttestations").mockResolvedValue([attestation] as never)
    jest.spyOn(SolanaLiqSyndicationTool, "readPoolBalance").mockResolvedValue(9n)
    await expect(
      BatchOperatorUnderwritingSteps.readSettledCustody(fixtureContext(), "custody")
    ).resolves.toEqual({ pool: 9n, attestations: [attestation] })
    // One read finds the yield unreported; the next poll's two bracket the pool.
    expect(yieldState).toHaveBeenCalledTimes(3)
    expect(push).not.toHaveBeenCalled()
  })
})
