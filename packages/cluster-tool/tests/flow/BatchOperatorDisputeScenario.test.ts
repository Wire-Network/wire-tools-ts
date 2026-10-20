import { Constants as TestClusterConstants } from "@wireio/cluster-tool"
import {
  BatchOperatorDisputeConstants as Constants,
  BatchOperatorDisputeScenario,
  BatchOperatorSlashingScenario,
  BatchOperatorDisputeSteps as DisputeSteps,
  BatchOperatorTerminalTieScenario,
  type BatchOperatorDisputeScenarioOptions
} from "@wireio/cluster-tool/flow"
import {
  ClusterBuild,
  type ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup
} from "@wireio/cluster-tool/orchestration"
import { NodeOwnerTier, OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

import { fixtureContext } from "../config/clusterBuildContextFixture.js"
import { fixtureOperatorAccount } from "../orchestration/outputs/operatorAccountFixture.js"
import { fixtureOperatorRow } from "../orchestration/steps/contracts/sysio/opregOperatorRowFixture.js"

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

interface OperatorStatusFixture {
  readonly ctx: ClusterBuildContext
  readonly label: string
}

function epochStateRow(
  overrides: Partial<SysioContracts.SysioEpochEpochStateType> = {}
): SysioContracts.SysioEpochEpochStateType {
  return {
    current_epoch_index: ContestedEpoch,
    current_epoch_start: "2026-08-28T00:00:00.000",
    next_epoch_start: "2026-08-28T00:01:00.000",
    current_batch_op_group: 0,
    batch_op_groups: [["wireno.a", "wireno.b", "wireno.c"]],
    last_consensus_hash: "",
    is_paused: false,
    ...overrides
  }
}

function chainInfo(headBlockTime: string) {
  return {
    server_version: "test",
    chain_id: "00".repeat(32),
    head_block_num: 10,
    last_irreversible_block_num: 9,
    head_block_time: headBlockTime,
    head_block_id: "11".repeat(32),
    head_block_producer: "sysio"
  }
}

function registerDisputeOperators(ctx: ClusterBuildContext): string[] {
  return Constants.DisputeOperators.map((label, index) => {
    const account = `wireno.disp${index}`
    ctx.keyStore.setOperator(
      fixtureOperatorAccount(label, OperatorType.BATCH, account)
    )
    return account
  })
}

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
  new BatchOperatorTerminalTieScenario().plan(build)
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

function operatorStatusFixture(
  status: SysioContracts.SysioOpregOperatorstatus
): OperatorStatusFixture {
  const ctx = fixtureContext(),
    label = "dispop.b",
    account = "wireno.observe",
    contract = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg)
  ctx.keyStore.setOperator(
    fixtureOperatorAccount(label, OperatorType.BATCH, account)
  )
  jest.spyOn(contract.tables.operators, "query").mockResolvedValue({
    rows: [fixtureOperatorRow(account, undefined, { status })],
    more: false
  })
  jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)
  return { ctx, label }
}

function awaitDisputeInput(
  expectedCandidateCount: number
): DisputeSteps.AwaitDisputeOpenedInput {
  return {
    kind: "BatchOperatorDisputeSteps.AwaitDisputeOpenedInput",
    expectedCandidateCount
  }
}

describe("BatchOperatorDisputeScenario", () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it("keeps the configured three-member group while opening a two-candidate dispute", () => {
    const scenario = new BatchOperatorTerminalTieScenario()
    const build = newBuild()

    scenario.plan(build)

    expect(scenario.defaults.operatorsPerEpoch).toBe(3)
    expect(scenario.name).toBe("flow-batch-operator-terminal-tie")

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
    expect(
      phaseNamed(build, "SlashNonCanonical").steps.map(step => step.name)
    ).toEqual([
      "advance-for-slash",
      "dispop.b-slashed",
      "canonical-not-slashed"
    ])
  })

  it("preserves the original three-candidate composition", () => {
    const build = newBuild()
    const scenario = new BatchOperatorSlashingScenario()
    scenario.plan(build)

    expect(scenario.name).toBe("flow-batch-operator-slashing")

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
    expect(
      phaseNamed(build, "SlashNonCanonical").steps.map(step => step.name)
    ).toEqual([
      "advance-for-slash",
      "dispop.b-slashed",
      "dispop.c-slashed",
      "canonical-not-slashed"
    ])
  })

  it("rejects a delivery operator outside the provisioned dispute roster", () => {
    const options = {
      ...TerminalTieOptions,
      deliveryOperators: ["dispop.a", "ghost"],
      losingOperators: []
    } as const

    expect(() => {
      // @ts-expect-error Exercise runtime validation for untyped JavaScript callers.
      new TestBatchOperatorDisputeScenario(options).plan(newBuild())
    }).toThrow(
      "every delivering operator must belong to the provisioned dispute roster"
    )
  })

  it("rejects duplicate delivery operators", () => {
    const options = {
      ...TerminalTieOptions,
      deliveryOperators: ["dispop.a", "dispop.a"],
      losingOperators: []
    } satisfies BatchOperatorDisputeScenarioOptions

    expect(() =>
      new TestBatchOperatorDisputeScenario(options).plan(newBuild())
    ).toThrow("delivery operators must be distinct")
  })

  it("rejects duplicate slashing targets", () => {
    const options = {
      ...ThreeWayOptions,
      losingOperators: ["dispop.b", "dispop.b"]
    } satisfies BatchOperatorDisputeScenarioOptions

    expect(() =>
      new TestBatchOperatorDisputeScenario(options).plan(newBuild())
    ).toThrow("slashing targets must be distinct")
  })

  it("rejects two deliveries when no scheduled operator is terminated", () => {
    const options = {
      ...TerminalTieOptions,
      terminatedOperator: undefined
    } satisfies BatchOperatorDisputeScenarioOptions

    expect(() =>
      new TestBatchOperatorDisputeScenario(options).plan(newBuild())
    ).toThrow(
      "a non-terminal dispute must include all three scheduled operators"
    )
  })

  it("rejects incomplete non-canonical slashing coverage", () => {
    const options = {
      ...ThreeWayOptions,
      losingOperators: ["dispop.b"]
    } satisfies BatchOperatorDisputeScenarioOptions

    expect(() =>
      new TestBatchOperatorDisputeScenario(options).plan(newBuild())
    ).toThrow("slashing targets must be exactly the non-canonical deliverers")
  })

  it("plans voter registration through the canonical ROA factories", () => {
    const build = newBuild()
    new TestBatchOperatorDisputeScenario(TerminalTieOptions).plan(build)
    const steps = phaseNamed(
        groupNamed(build, "SetupDispute"),
        "ProvisionVoters"
      ).steps,
      create = steps.find(step => step.name === "create-voter1"),
      register = steps.find(step => step.name === "register-voter1")

    expect(create?.input).toEqual({
      kind: "RoaContractSteps.NewnameduserInput",
      data: {
        account: "voter1",
        pubkey: TestClusterConstants.DEV_K1_PUBLIC_KEY,
        tier: NodeOwnerTier.T1
      }
    })
    expect(register?.input).toEqual({
      kind: "RoaContractSteps.NodeownregInput",
      data: {
        owner: "voter1",
        tier: NodeOwnerTier.T1,
        eth_address: expect.stringMatching(/^[0-9a-f]{40}$/),
        eth_pub_key: expect.stringMatching(/^PUB_EM_/),
        wire_pub_key: TestClusterConstants.DEV_K1_PUBLIC_KEY
      }
    })
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

  it("submits a tagged envelope through the canonical msgch action runner", async () => {
    const ctx = fixtureContext(),
      account = "wireno.deliver",
      contract = ctx.wire.getSysioContract(
        SysioContracts.SysioContractName.msgch
      ),
      query = jest
        .spyOn(contract.tables.outpcons, "query")
        .mockResolvedValue({ rows: [], more: false }),
      invoke = jest
        .spyOn(contract.actions.deliver, "invoke")
        .mockResolvedValue(undefined)
    ctx.outputs.set(DisputeSteps.ContestedEpochKey, ContestedEpoch)
    ctx.keyStore.setOperator(
      fixtureOperatorAccount("dispop.a", OperatorType.BATCH, account)
    )
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)

    await DisputeSteps.runDeliverTaggedEnvelope(
      ctx,
      {
        kind: "BatchOperatorDisputeSteps.DeliverTaggedEnvelopeInput",
        batchOperatorLabel: "dispop.a",
        chainCode: 9_001,
        tag: "canonical"
      },
      new AbortController().signal
    )

    expect(query).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(
      {
        batch_op_name: account,
        chain_code: 9_001,
        data: expect.stringMatching(/^[0-9a-f]+$/)
      },
      { authorization: [{ actor: account, permission: "active" }] }
    )
  })

  it("votes for the stored canonical target through the canonical chalg runner", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(
        SysioContracts.SysioContractName.chalg
      ),
      invoke = jest
        .spyOn(contract.actions.votedispute, "invoke")
        .mockResolvedValue(undefined)
    ctx.outputs.set(DisputeSteps.DisputeResolutionKey, {
      disputeId: Number(DisputeId),
      canonicalChecksum: CanonicalChecksum
    })
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract)

    await DisputeSteps.runVoteCanonicalDispute(
      ctx,
      {
        kind: "BatchOperatorDisputeSteps.VoteCanonicalDisputeInput",
        owner: "voter1"
      },
      new AbortController().signal
    )

    expect(invoke).toHaveBeenCalledWith(
      {
        owner: "voter1",
        dispute_id: Number(DisputeId),
        chosen_checksum: CanonicalChecksum
      },
      { authorization: [{ actor: "voter1", permission: "active" }] }
    )
  })

  it("stages the contested epoch only after the chain clock passes its boundary", async () => {
    const ctx = fixtureContext()
    jest
      .spyOn(ctx.wire, "getEpochState")
      .mockResolvedValue({ rows: [epochStateRow()], more: false })
    jest
      .spyOn(ctx.wire, "getInfo")
      .mockResolvedValue(chainInfo("2026-08-28T00:02:00.000"))

    await DisputeSteps.runStageContestedEpoch(
      ctx,
      null,
      new AbortController().signal
    )

    expect(ctx.outputs.assert(DisputeSteps.ContestedEpochKey)).toBe(
      ContestedEpoch
    )
  })

  it("settles only after the dispute-owned epoch is stable", async () => {
    jest.useFakeTimers()
    const ctx = fixtureContext(),
      accounts = registerDisputeOperators(ctx)
    jest.spyOn(ctx.wire, "getEpochState").mockResolvedValue({
      rows: [epochStateRow({ batch_op_groups: [accounts] })],
      more: false
    })

    const result = DisputeSteps.settleOnDisputeEpoch(ctx)
    await jest.runAllTimersAsync()

    await expect(result).resolves.toBe(ContestedEpoch)
  })

  it("accepts only the resolved canonical winner", async () => {
    const ctx = disputeRunnerFixture(2),
      contract = ctx.wire.getSysioContract(
        SysioContracts.SysioContractName.chalg
      )
    ctx.outputs.set(DisputeSteps.DisputeResolutionKey, {
      disputeId: Number(DisputeId),
      canonicalChecksum: CanonicalChecksum
    })
    jest.spyOn(contract.tables.disputes, "query").mockResolvedValue({
      rows: [
        {
          ...disputeRow(2),
          status:
            SysioContracts.SysioChalgDisputestatus.DISPUTE_STATUS_RESOLVED,
          winning_checksum: CanonicalChecksum
        }
      ],
      more: false
    })

    await expect(
      DisputeSteps.runAwaitDisputeResolved(
        ctx,
        null,
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
  })

  it("observes an operator become SLASHED", async () => {
    const { ctx, label } = operatorStatusFixture(
      SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_SLASHED
    )

    await expect(
      DisputeSteps.runAwaitOperatorSlashed(
        ctx,
        {
          kind: "BatchOperatorDisputeSteps.AwaitOperatorSlashedInput",
          label
        },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
  })

  it("observes an operator become ACTIVE", async () => {
    const { ctx, label } = operatorStatusFixture(
      SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
    )

    await expect(
      DisputeSteps.runAwaitOperatorActive(
        ctx,
        {
          kind: "BatchOperatorDisputeSteps.AwaitOperatorActiveInput",
          label
        },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
  })

  it("performs no semantic runner work when pre-aborted", async () => {
    const ctx = fixtureContext(),
      controller = new AbortController()
    controller.abort()

    await expect(
      DisputeSteps.runStageContestedEpoch(ctx, null, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(ctx.outputs.has(DisputeSteps.ContestedEpochKey)).toBe(false)
  })
})
