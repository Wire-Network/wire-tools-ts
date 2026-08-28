import {
  BatchOperatorDisputeScenario,
  SlashingScenarioConstants as Constants,
  type BatchOperatorDisputeScenarioOptions
} from "@wireio/cluster-tool/flow"
import { SlashingScenarioDisputeSteps as DisputeSteps } from "@wireio/cluster-tool/flow/steps"
import {
  ClusterBuild,
  type ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup
} from "@wireio/cluster-tool/orchestration"
import { OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureContext } from "../config/clusterBuildContextFixture.js"
import { fixtureOperatorAccount } from "../orchestration/outputs/operatorAccountFixture.js"

const TerminalTieOptions = {
  name: "terminal-tie-test",
  description: "two live operators contest a three-member scheduled group",
  deliveryOperators: ["dispop.a", "dispop.b"],
  candidateTags: ["canonical", "fork"],
  losingOperators: ["dispop.b"],
  terminatedOperator: "dispop.c"
} satisfies BatchOperatorDisputeScenarioOptions

const ThreeWayOptions = {
  name: "three-way-test",
  description: "three live operators deliver three distinct candidates",
  deliveryOperators: Constants.DisputeOperators,
  candidateTags: Constants.EnvelopeTags,
  losingOperators: Constants.LosingOperators
} satisfies BatchOperatorDisputeScenarioOptions

const ContestedEpoch = 17,
  DisputeId = "42",
  CanonicalAccount = "wireno.x3f9k",
  CanonicalChecksum = "canonical-checksum"

class TestBatchOperatorDisputeScenario extends BatchOperatorDisputeScenario {
  constructor(options: BatchOperatorDisputeScenarioOptions) {
    super(options)
  }
}

function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(fixtureContext())
}

function groupNamed(
  parent: ClusterBuild | ClusterBuildPhaseGroup,
  name: string
): ClusterBuildPhaseGroup {
  const group = parent.children.find(
    child => child instanceof ClusterBuildPhaseGroup && child.name === name
  )
  if (!(group instanceof ClusterBuildPhaseGroup)) {
    throw new Error(`missing phase group ${name}`)
  }
  return group
}

function phaseNamed(
  parent: ClusterBuild | ClusterBuildPhaseGroup,
  name: string
): ClusterBuildPhase {
  const phase = parent.children.find(
    child => child instanceof ClusterBuildPhase && child.name === name
  )
  if (!(phase instanceof ClusterBuildPhase)) {
    throw new Error(`missing phase ${name}`)
  }
  return phase
}

function configuredGroupSizeStep() {
  const build = newBuild()
  new TestBatchOperatorDisputeScenario(TerminalTieOptions).plan(build)
  const degradedGroup = phaseNamed(
    groupNamed(build, "SetupDispute"),
    "DegradeLiveGroup"
  )
  const step = degradedGroup.steps.find(
    candidate => candidate.name === "configured-group-size"
  )
  if (step == null) throw new Error("missing configured-group-size step")
  return step
}

function contextWithConfiguredGroupSize(
  operatorsPerEpoch: number
): ClusterBuildContext {
  const ctx = fixtureContext()
  jest.spyOn(ctx.wire, "getEpochConfig").mockResolvedValue({
    rows: [
      {
        epoch_duration_sec: Constants.EpochDurationSec,
        operators_per_epoch: operatorsPerEpoch,
        batch_operator_minimum_active: Constants.DisputeOperatorCount,
        batch_op_groups: Constants.DisputeBatchOperatorGroupCount,
        epoch_retention_envelope_log_count:
          Constants.EpochRetentionEnvelopeLogCount
      }
    ],
    more: false
  })
  return ctx
}

function disputeRow(
  candidateCount: number,
  id: number | string = DisputeId,
  chainCode: number | string = Constants.ContestedChainCode
): SysioContracts.SysioChalgDisputeEntryType {
  return {
    id,
    chain_code: String(chainCode),
    epoch_index: ContestedEpoch,
    status: SysioContracts.SysioChalgDisputestatus.DISPUTE_STATUS_OPEN,
    winning_checksum: "",
    opened_at: "2026-08-28T00:00:00",
    deadline: "2026-08-28T00:01:00",
    candidates: [
      { checksum: CanonicalChecksum, operators: [CanonicalAccount] },
      ...Array.from({ length: candidateCount - 1 }, (_unused, index) => ({
        checksum: `fork-checksum-${index + 1}`,
        operators: [`wireno.fork${index + 1}`]
      }))
    ],
    network_gen: 1,
    electorate: ["voter1", "voter2", "voter3"],
    quorum: 2
  }
}

function disputeRunnerFixture(
  candidateCount: number,
  ...leadingRows: SysioContracts.SysioChalgDisputeEntryType[]
): ClusterBuildContext {
  const ctx = fixtureContext()
  ctx.outputs.set(DisputeSteps.ContestedEpochKey, ContestedEpoch)
  ctx.keyStore.setOperator(
    fixtureOperatorAccount(
      Constants.CanonicalOperator,
      OperatorType.BATCH,
      CanonicalAccount
    )
  )
  const contract = ctx.wire.getSysioContract(
    SysioContracts.SysioContractName.chalg
  )
  jest.spyOn(contract.tables.disputes, "query").mockResolvedValue({
    rows: [...leadingRows, disputeRow(candidateCount)],
    more: false
  })
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
  return ctx
}

function awaitDisputeInput(
  expectedCandidateCount: number
): DisputeSteps.AwaitDisputeOpenedInput {
  return {
    kind: "SlashingScenarioDisputeSteps.AwaitDisputeOpenedInput",
    expectedCandidateCount
  }
}

describe("BatchOperatorDisputeScenario", () => {
  it("keeps the configured three-member group while opening a two-candidate dispute", () => {
    const scenario = new TestBatchOperatorDisputeScenario(TerminalTieOptions)
    const build = newBuild()

    scenario.plan(build)

    expect(scenario.defaults.operatorsPerEpoch).toBe(3)

    const setup = groupNamed(build, "SetupDispute")
    const degradedGroup = phaseNamed(setup, "DegradeLiveGroup")
    expect(degradedGroup.steps.map(step => step.name)).toEqual([
      "terminate-dispop.c",
      "dispop.c-terminated",
      "configured-group-size"
    ])

    const inject = groupNamed(build, "InjectDivergent")
    const disputeOpens = phaseNamed(inject, "DisputeOpens")
    const disputeWait = disputeOpens.steps.find(
      step => step.name === "dispute-opens"
    )
    expect(disputeWait?.input).toMatchObject({ expectedCandidateCount: 2 })
  })

  it("preserves the original three-candidate composition", () => {
    const build = newBuild()
    new TestBatchOperatorDisputeScenario(ThreeWayOptions).plan(build)

    expect(
      groupNamed(build, "SetupDispute").children.some(
        child => child.name === "DegradeLiveGroup"
      )
    ).toBe(false)
    expect(
      phaseNamed(
        groupNamed(build, "InjectDivergent"),
        "CandidateEthereumDeliveries"
      ).steps.map(step => step.name)
    ).toEqual([
      "dispop.a-deliver-ethereum",
      "dispop.b-deliver-ethereum",
      "dispop.c-deliver-ethereum"
    ])
    const disputeWait = phaseNamed(
      groupNamed(build, "InjectDivergent"),
      "DisputeOpens"
    ).steps.find(step => step.name === "dispute-opens")
    expect(disputeWait?.input).toMatchObject({ expectedCandidateCount: 3 })
  })

  it("rejects a terminal-tie run if epochcfg no longer retains three operators", async () => {
    const step = configuredGroupSizeStep()
    const signal = new AbortController().signal

    await step.runner(contextWithConfiguredGroupSize(3), step.input, signal)
    await expect(
      step.runner(contextWithConfiguredGroupSize(2), step.input, signal)
    ).rejects.toThrow("epochcfg.operators_per_epoch must remain 3")
  })

  it.each([2, 3])(
    "accepts an OPEN dispute with %i candidates and stores the canonical resolution target",
    async expectedCandidateCount => {
      const ctx = disputeRunnerFixture(expectedCandidateCount)

      await DisputeSteps.runAwaitDisputeOpened(
        ctx,
        awaitDisputeInput(expectedCandidateCount),
        new AbortController().signal
      )

      expect(ctx.outputs.assert(DisputeSteps.DisputeResolutionKey)).toEqual({
        disputeId: Number(DisputeId),
        canonicalChecksum: CanonicalChecksum
      })
    }
  )

  it("ignores an OPEN dispute for another outpost in the contested epoch", async () => {
    const ctx = disputeRunnerFixture(
      2,
      disputeRow(2, "99", Constants.NonContestedChainCode)
    )

    await DisputeSteps.runAwaitDisputeOpened(
      ctx,
      awaitDisputeInput(2),
      new AbortController().signal
    )

    expect(ctx.outputs.assert(DisputeSteps.DisputeResolutionKey)).toEqual({
      disputeId: Number(DisputeId),
      canonicalChecksum: CanonicalChecksum
    })
  })

  it("rejects a dispute whose live candidate count differs from the plan", async () => {
    const ctx = disputeRunnerFixture(2)

    await expect(
      DisputeSteps.runAwaitDisputeOpened(
        ctx,
        awaitDisputeInput(3),
        new AbortController().signal
      )
    ).rejects.toThrow("expected exactly 3 dispute candidates, got 2")

    expect(ctx.outputs.has(DisputeSteps.DisputeResolutionKey)).toBe(false)
  })
})
