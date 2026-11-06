import { OperatorType } from "@wireio/opp-typescript-models"
import { ProtocolTiming } from "@wireio/cluster-tool"
import { getLogger } from "@wireio/cluster-tool/logging"
import {
  ClusterBuild,
  ClusterBuildContext,
  SolanaOutpostBootstrapper,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import {
  SolanaLiqSyndicationTool,
  WireState
} from "@wireio/cluster-tool/tools/solana"
import { solanaNativePublicKey } from "@wireio/cluster-tool/utils"

import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { fixtureOperatorAccount } from "../outputs/operatorAccountFixture.js"

/** A batch `OperatorAccount` under an explicit chain account name. */
const batchOperator = (label: string, account: string) =>
  fixtureOperatorAccount(label, OperatorType.BATCH, account)

describe("Steps.solanaOutpost.deploy", () => {
  it("builds an input-less deploy step with a runner", () => {
    const step = Steps.solanaOutpost.planDeploy(
      Report.Actor.SolanaOutpost,
      "deploy-solana-outpost",
      "deploy the Solana outpost",
      {}
    )
    expect(step.actor).toBe(Report.Actor.SolanaOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})

describe("Steps.solanaOutpost.launch", () => {
  const context = new ClusterBuildContext(
      fixtureConfig(),
      getLogger("solana-outpost-launch-test")
    ),
    signal = new AbortController().signal

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("registers Launching, then PostLaunch, then the read-back on its parent", () => {
    const cluster = ClusterBuild.forContext(context),
      phase = Steps.solanaOutpost.planLaunch(
        cluster,
        "SolanaOutpostLaunch",
        "take the outpost out of pre-launch",
        {}
      )
    expect(cluster.children).toEqual([phase])
    expect(phase.name).toBe("SolanaOutpostLaunch")
    expect(phase.steps.map(step => step.name)).toEqual([
      "set-wire-state-launching",
      "set-wire-state-post-launch",
      "verify-post-launch"
    ])
    // Two admin writes through the one set_wire_state factory, in the only
    // order liqsol_core accepts, then the input-less verify.
    expect(phase.steps.map(step => step.input)).toEqual([
      {
        kind: "SolanaLiqSyndicationTool.SetWireStateInput",
        wireState: WireState.launching
      },
      {
        kind: "SolanaLiqSyndicationTool.SetWireStateInput",
        wireState: WireState.postLaunch
      },
      null
    ])
    expect(phase.steps.slice(0, 2).map(step => step.runner)).toEqual([
      SolanaLiqSyndicationTool.runSetWireState,
      SolanaLiqSyndicationTool.runSetWireState
    ])
    expect(new Set(phase.steps.map(step => step.actor))).toEqual(
      new Set([Report.Actor.SolanaOutpost])
    )
  })

  it("applies the caller's step options to every step", () => {
    const options = { timeoutMs: ProtocolTiming.OutpostWriteBudgetMs },
      phase = Steps.solanaOutpost.planLaunch(
        ClusterBuild.forContext(context),
        "SolanaOutpostLaunch",
        "take the outpost out of pre-launch",
        options
      )
    expect(phase.steps.map(step => step.options)).toEqual([
      options,
      options,
      options
    ])
  })

  it("passes the read-back step when the outpost is PostLaunch", async () => {
    const readWireState = jest
        .spyOn(SolanaLiqSyndicationTool, "readWireState")
        .mockResolvedValue(WireState.postLaunch),
      [, , verify] = Steps.solanaOutpost.planLaunch(
        ClusterBuild.forContext(context),
        "SolanaOutpostLaunch",
        "take the outpost out of pre-launch",
        {}
      ).steps
    await expect(
      verify.runner(context, verify.input, signal)
    ).resolves.toBeUndefined()
    expect(readWireState).toHaveBeenCalledWith(context)
  })

  it.each([WireState.preLaunch, WireState.launching, WireState.refund])(
    "fails the read-back, naming the state, when the outpost is %s",
    async state => {
      jest
        .spyOn(SolanaLiqSyndicationTool, "readWireState")
        .mockResolvedValue(state)
      await expect(
        Steps.solanaOutpost.assertPostLaunch(context)
      ).rejects.toThrow(
        `the outpost is in ${state}, not ${WireState.postLaunch}`
      )
    }
  )
})

describe("Steps.solanaOutpost.oppBootstrap", () => {
  it("builds an input-less opp_bootstrap step with a runner", () => {
    const step = Steps.solanaOutpost.planOppBootstrap(
      Report.Actor.SolanaOutpost,
      "seed-solana-roster",
      "seed the Solana outpost operator registry",
      {}
    )
    expect(step.actor).toBe(Report.Actor.SolanaOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("seeds a roster of EXACTLY the epoch-1 group's operators, in group order", () => {
    const operators = [
      batchOperator("batch-op-00", "batchopa"),
      batchOperator("batch-op-01", "batchopb"),
      batchOperator("batch-op-02", "batchopc")
    ]
    // The depot's epoch-1 group is a strict subset of the provisioned roster.
    const seed = Steps.solanaOutpost.resolveOppBootstrapSeed(operators, [
      "batchopa",
      "batchopc"
    ])

    // Roster = the group's operators only — the minimal signable seed...
    expect(seed.operators).toHaveLength(2)
    expect(seed.operators[0].solAddress.toBase58()).toBe(
      solanaNativePublicKey(operators[0].solana)
    )
    expect(seed.operators[1].solAddress.toBase58()).toBe(
      solanaNativePublicKey(operators[2].solana)
    )
    // ...group = the same members, in order, mapped to their SOL keys.
    expect(seed.groupMembers).toHaveLength(2)
    expect(seed.groupMembers[0].toBase58()).toBe(
      solanaNativePublicKey(operators[0].solana)
    )
    expect(seed.groupMembers[1].toBase58()).toBe(
      solanaNativePublicKey(operators[2].solana)
    )
    // Every roster entry is BATCH + ACTIVE with a positive wire-name encoding.
    seed.operators.forEach(operator => {
      expect(operator.role).toBe(OperatorType.BATCH)
      expect(operator.wireName.gtn(0)).toBe(true)
    })
  })

  it("stays group-bounded on a soak-scale topology (Anchor's fixed instruction buffer)", () => {
    // 21 provisioned batch operators (the emissions-soak topology) with the
    // depot's usual 3-member epoch-1 group. The seed must scale with the GROUP,
    // never the topology: a full-roster seed would encode 21 roster entries
    // against a buffer that admits at most
    // `SolanaOutpostBootstrapper.MaxOppBootstrapGroupMembers` members.
    const operators = Array.from({ length: 21 }, (_, index) =>
        batchOperator(
          `batch-op-${index}`,
          `batchop${String.fromCharCode(97 + index)}`
        )
      ),
      groupAccounts = [
        operators[0].account,
        operators[7].account,
        operators[20].account
      ]
    const seed = Steps.solanaOutpost.resolveOppBootstrapSeed(
      operators,
      groupAccounts
    )

    expect(seed.operators).toHaveLength(groupAccounts.length)
    expect(seed.groupMembers).toHaveLength(groupAccounts.length)
    seed.groupMembers.forEach((member, index) =>
      expect(member.toBase58()).toBe(
        seed.operators[index].solAddress.toBase58()
      )
    )
  })

  it("caps the seed at MaxOppBootstrapOperators when the depot's group is larger", () => {
    // A 9-member epoch-1 group: `opp_bootstrap` carries the roster AND the
    // group in ONE transaction, so only the first `MaxOppBootstrapOperators`
    // are seeded.
    const operators = Array.from({ length: 9 }, (_, index) =>
        batchOperator(
          `batch-op-${index}`,
          `batchop${String.fromCharCode(97 + index)}`
        )
      ),
      groupAccounts = operators.map(operator => operator.account)
    const seed = Steps.solanaOutpost.resolveOppBootstrapSeed(
      operators,
      groupAccounts
    )

    expect(groupAccounts.length).toBeGreaterThan(
      Steps.solanaOutpost.MaxOppBootstrapOperators
    )
    expect(seed.operators).toHaveLength(
      Steps.solanaOutpost.MaxOppBootstrapOperators
    )
    expect(seed.groupMembers).toHaveLength(
      Steps.solanaOutpost.MaxOppBootstrapOperators
    )
    // The cap keeps the group's LEADING members, in order.
    seed.operators.forEach((operator, index) =>
      expect(operator.solAddress.toBase58()).toBe(
        solanaNativePublicKey(operators[index].solana)
      )
    )
    seed.groupMembers.forEach((member, index) =>
      expect(member.toBase58()).toBe(
        seed.operators[index].solAddress.toBase58()
      )
    )
  })

  it("never resolves group members past the cap", () => {
    // The 6th member is unprovisioned — beyond the cap it is never looked up,
    // so it cannot fail a seed it is not part of.
    const operators = Array.from({ length: 5 }, (_, index) =>
        batchOperator(
          `batch-op-${index}`,
          `batchop${String.fromCharCode(97 + index)}`
        )
      ),
      groupAccounts = [
        ...operators.map(operator => operator.account),
        "ghostop"
      ]

    const seed = Steps.solanaOutpost.resolveOppBootstrapSeed(
      operators,
      groupAccounts
    )
    expect(seed.operators).toHaveLength(
      Steps.solanaOutpost.MaxOppBootstrapOperators
    )
  })

  it("pins MaxOppBootstrapOperators under the transaction-packet ceiling", () => {
    expect(Steps.solanaOutpost.MaxOppBootstrapOperators).toBe(5)
    // The cap must stay within what `oppBootstrap` itself will encode.
    expect(Steps.solanaOutpost.MaxOppBootstrapOperators).toBeLessThanOrEqual(
      SolanaOutpostBootstrapper.MaxOppBootstrapGroupMembers
    )
  })

  it("throws when an epoch-1 group member is not a provisioned batch operator", () => {
    const operators = [batchOperator("batch-op-00", "batchopa")]
    expect(() =>
      Steps.solanaOutpost.resolveOppBootstrapSeed(operators, ["ghostop"])
    ).toThrow(/ghostop.*not found among provisioned batch operators/)
  })

  it("throws a DISTINCT error when a group member carries no Solana key", () => {
    // Present in the roster but unprovisioned on SOL — a different failure from
    // "not found", and the message must say which.
    const operators = [
      { ...batchOperator("batch-op-00", "batchopa"), solana: null }
    ]
    expect(() =>
      Steps.solanaOutpost.resolveOppBootstrapSeed(operators, ["batchopa"])
    ).toThrow(/batchopa has no Solana key/)
  })
})
