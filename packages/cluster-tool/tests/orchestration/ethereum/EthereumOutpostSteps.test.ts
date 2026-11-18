import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { getLogger } from "@wireio/shared"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Constants } from "@wireio/cluster-tool"
import { EthereumWallet } from "@wireio/cluster-tool/clients/ethereum"
import {
  ClusterBuildContext,
  EthereumOutpostSteps,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { EthereumSyndicationTool } from "@wireio/cluster-tool/tools/ethereum"
import type { EthereumKeyPair } from "@wireio/cluster-tool/types"
import { ethereumKeyPairFromWallet } from "@wireio/cluster-tool/utils"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { fixtureOperatorAccount } from "../outputs/operatorAccountFixture.js"

/** A batch `OperatorAccount` under an explicit chain account name, with its OWN random EM key. */
const batchOperator = (label: string, account: string) =>
  fixtureOperatorAccount(label, OperatorType.BATCH, account)

/** The depot's epoch duration for the seed cases. */
const SeedEpochDurationSec = 60

/** A context over the persisted fixture, optionally reshaped for a case. */
const context = (overrides: Parameters<typeof fixtureConfig>[0] = {}) =>
  new ClusterBuildContext(
    fixtureConfig(overrides),
    getLogger("eth-outpost-test")
  )

/**
 * Materialize bootstrapped batch operators into the context's key store — what
 * the bootstrap's `OperatorKeys` phase does ahead of the Ethereum deploy — each
 * with its own RANDOM EM key, and return the SEEDED operators' addresses in
 * LABEL order (a label left unseeded is simply absent, so a case can model a
 * missing identity).
 *
 * @param ctx - The context whose key store receives the operators.
 * @param labels - The labels to materialize, in the order to insert them.
 * @returns The seeded operators' Ethereum addresses, in LABEL (not insertion) order.
 */
function seedBatchOperators(
  ctx: ClusterBuildContext,
  labels: string[] = Constants.batchOperatorLabels(
    ctx.config.batchOperatorCount
  )
): string[] {
  labels.forEach(label =>
    ctx.keyStore.setOperator(fixtureOperatorAccount(label, OperatorType.BATCH))
  )
  return Constants.batchOperatorLabels(ctx.config.batchOperatorCount)
    .filter(label => labels.includes(label))
    .map(label => ctx.keyStore.assertOperator(label).ethereum.address)
}

describe("Steps.ethereumOutpost.deploy", () => {
  it("defaults a fresh pool to zero booked fixture principal", () => {
    const step = Steps.ethereumOutpost.planDeploy(
      Report.Actor.EthereumOutpost,
      "deploy-ethereum-outpost",
      "deploy the Ethereum outpost",
      {}
    )
    expect(step.actor).toBe(Report.Actor.EthereumOutpost)
    expect(step.input).toEqual({
      kind: "EthereumOutpostSteps.DeployInput",
      mockSyndicatedPrincipal: 0n
    })
    expect(typeof step.runner).toBe("function")
  })

  it("carries the planned fixture principal into deployment", () => {
    const step = Steps.ethereumOutpost.planDeploy(
      Report.Actor.EthereumOutpost,
      "deploy",
      "deploy",
      {},
      110_000_000_000n
    )
    expect(step.input.mockSyndicatedPrincipal).toBe(110_000_000_000n)
  })
})

describe("EthereumOutpostSteps.resolveInitialRoster", () => {
  it("carries the depot's epoch duration", () => {
    const ctx = context({ epochDurationSec: 45 })
    seedBatchOperators(ctx)
    expect(EthereumOutpostSteps.resolveInitialRoster(ctx).epochDurationSec).toBe(
      45
    )
  })

  it("seats EVERY batch operator, at the address of the EM key its identity step materialized", () => {
    // The whole point of WNE-41 on a cluster: these are the addresses the
    // daemons sign `epochIn` with, and `isActiveOperator` is fail-closed.
    const ctx = context({
        batchOperatorCount: 3,
        operatorsPerEpoch: 3,
        batchOpGroups: 1
      }),
      addresses = seedBatchOperators(ctx),
      roster = EthereumOutpostSteps.resolveInitialRoster(ctx)
    // Order is the depot's business — `schbatchgps` interleaves before
    // partitioning — so this asserts MEMBERSHIP, which is what authorization
    // depends on.
    expect(roster.groups.flat().sort()).toEqual([...addresses].sort())
  })

  it("walks the batch-operator LABEL sequence, not the key store's insertion order", () => {
    const ctx = context({
        batchOperatorCount: 3,
        operatorsPerEpoch: 3,
        batchOpGroups: 1
      }),
      // Inserted c, b, a — the roster still reads a, b, c.
      [a, b, c] = seedBatchOperators(
        ctx,
        [...Constants.batchOperatorLabels(3)].reverse()
      )
    expect(EthereumOutpostSteps.resolveInitialRoster(ctx).groups[0]).toEqual([
      a,
      c,
      b
    ])
  })

  it("seats batch operators ONLY — an underwriter or producer in the key store never rides the roster", () => {
    const ctx = context(),
      underwriter = fixtureOperatorAccount(
        Constants.underwriterLabel(0),
        OperatorType.UNDERWRITER
      ),
      producer = fixtureOperatorAccount("defproducera", OperatorType.PRODUCER)
    seedBatchOperators(ctx)
    ctx.keyStore.setOperator(underwriter).setOperator(producer)
    const seated = EthereumOutpostSteps.resolveInitialRoster(ctx).groups.flat()
    expect(seated).not.toContain(underwriter.ethereum.address)
    expect(seated).not.toContain(producer.ethereum.address)
  })

  it("sizes group 0 by the depot's operators-per-epoch (the consensus threshold)", () => {
    // `OPPInbound` derives its threshold from `batchOpGroups[0].length`, so a
    // group 0 wider than the depot's active group would demand deliveries that
    // never come and stall the epoch.
    const ctx = context({
      batchOperatorCount: 9,
      operatorsPerEpoch: 3,
      batchOpGroups: 3
    })
    seedBatchOperators(ctx)
    const roster = EthereumOutpostSteps.resolveInitialRoster(ctx)
    expect(roster.groups).toHaveLength(3)
    roster.groups.forEach(group => expect(group).toHaveLength(3))
  })

  it("seats every scheduled operator across the window's slots, once", () => {
    // 9 operators, 3 groups of 3: the whole roster is scheduled, so every
    // address lands in exactly one slot — slot `k` serving epoch `1 + k`.
    const ctx = context({
        batchOperatorCount: 9,
        operatorsPerEpoch: 3,
        batchOpGroups: 3
      }),
      addresses = seedBatchOperators(ctx),
      roster = EthereumOutpostSteps.resolveInitialRoster(ctx)
    expect(roster.groups.flat()).toContain(addresses[8])
    expect(new Set(roster.groups.flat()).size).toBe(9)
  })

  it("interleaves the pool the way `schbatchgps` does", () => {
    // The depot shuffles evens-then-odds before partitioning, so group 0 is
    // [0, 2, 4] rather than [0, 1, 2]. Reproducing it keeps the initial
    // grouping the same SHAPE the depot installs on its first attestation.
    const ctx = context({
        batchOperatorCount: 9,
        operatorsPerEpoch: 3,
        batchOpGroups: 3
      }),
      addresses = seedBatchOperators(ctx)
    expect(EthereumOutpostSteps.resolveInitialRoster(ctx).groups[0]).toEqual([
      addresses[0],
      addresses[2],
      addresses[4]
    ])
  })

  it("throws when a batch operator's identity was never materialized", () => {
    // `OperatorKeys` runs before the deploy precisely so every address exists;
    // a missing one is a phase-order defect, not an empty seat.
    const ctx = context({ batchOperatorCount: 3 })
    seedBatchOperators(ctx, Constants.batchOperatorLabels(2))
    expect(() => EthereumOutpostSteps.resolveInitialRoster(ctx)).toThrow(
      new RegExp(Constants.batchOperatorLabel(2).replace(".", "\\."))
    )
  })

  it("throws a DISTINCT error when a materialized operator carries no Ethereum key", () => {
    const ctx = context({ batchOperatorCount: 3 })
    seedBatchOperators(ctx)
    ctx.keyStore.setOperator({
      ...batchOperator(Constants.batchOperatorLabel(1), "acct.bbbbb"),
      ethereum: undefined
    })
    expect(() => EthereumOutpostSteps.resolveInitialRoster(ctx)).toThrow(
      /batchop\.b has no Ethereum key/
    )
  })
})

describe("EthereumOutpostSteps.partitionLikeDepot", () => {
  const pool = (count: number) =>
    Array.from({ length: count }, (_unused, index) => `0x${index}`)

  it("trims to batch_operator_minimum_active before grouping", () => {
    // 9 addresses but the depot only schedules 3: group 0's length is the
    // consensus threshold, so the untrimmed pool must not widen it.
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(9), 3, 1, 3)
    expect(groups[0]).toHaveLength(3)
  })

  it("leaves operators past the scheduled window OUT — the depot leaves them ungrouped too", () => {
    // Under WNE-27 a slot authorizes its members for the epoch it serves, so a
    // seat for an unscheduled operator would authorize it for an epoch the
    // depot never scheduled it for. It stays ACTIVE and ungrouped, as on the
    // depot, until a rotation schedules it.
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(5), 3, 1, 3)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(3)
    expect(groups.flat()).not.toContain("0x3")
    expect(groups.flat()).not.toContain("0x4")
  })

  it("emits exactly batch_op_groups groups when the pool fills them", () => {
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(9), 3, 3, 9)
    expect(groups).toHaveLength(3)
    expect(groups[0]).toEqual(["0x0", "0x2", "0x4"])
  })

  it("never emits an EMPTY group — the contract rejects one", () => {
    // A pool short of `batchOpGroups * operatorsPerEpoch` yields fewer groups
    // rather than padded ones; `_installInitialRoster` reverts on an empty one.
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(3), 3, 3, 3)
    expect(groups.every(group => group.length > 0)).toBe(true)
    expect(groups.flat()).toHaveLength(3)
  })
})

describe("Steps.ethereumOutpost.oppBootstrap", () => {
  it("builds an input-less installInitialRoster step with a runner", () => {
    const step = Steps.ethereumOutpost.planOppBootstrap(
      Report.Actor.EthereumOutpost,
      "seed-ethereum-roster",
      "seed the Ethereum outpost batch-operator roster",
      {}
    )
    expect(step.actor).toBe(Report.Actor.EthereumOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("maps every window slot, in slot order, to its members' EM addresses", () => {
    const operators = [
      batchOperator("batchop.a", "acct.aaaaa"),
      batchOperator("batchop.b", "acct.bbbbb"),
      batchOperator("batchop.c", "acct.ccccc")
    ]
    // The depot's window orders by ACCOUNT NAME, which need not follow the
    // harness's label order — exactly the gap the seed exists to close.
    const seed = EthereumOutpostSteps.resolveOppBootstrapSeed(
      operators,
      [["acct.ccccc"], ["acct.aaaaa"], ["acct.bbbbb"]],
      0,
      SeedEpochDurationSec
    )

    expect(seed.window.groups).toEqual([
      [operators[2].ethereum.address],
      [operators[0].ethereum.address],
      [operators[1].ethereum.address]
    ])
    expect(new Set(seed.window.groups.flat()).size).toBe(3)
    expect(seed.window.epochDurationSec).toBe(SeedEpochDurationSec)
    expect(seed.activeGroupIndex).toBe(0)
  })

  it("keeps member order within a multi-member slot and carries the depot's active slot", () => {
    const operators = [
      batchOperator("batchop.a", "acct.aaaaa"),
      batchOperator("batchop.b", "acct.bbbbb"),
      batchOperator("batchop.c", "acct.ccccc")
    ]
    const seed = EthereumOutpostSteps.resolveOppBootstrapSeed(
      operators,
      [["acct.bbbbb", "acct.aaaaa", "acct.ccccc"]],
      0,
      SeedEpochDurationSec
    )
    expect(seed.window.groups).toEqual([
      [
        operators[1].ethereum.address,
        operators[0].ethereum.address,
        operators[2].ethereum.address
      ]
    ])
    // A rotated depot cursor rides through untouched.
    expect(
      EthereumOutpostSteps.resolveOppBootstrapSeed(
        operators,
        [["acct.aaaaa"], ["acct.bbbbb"]],
        1,
        SeedEpochDurationSec
      ).activeGroupIndex
    ).toBe(1)
  })

  it("throws when a scheduled account is not a provisioned batch operator", () => {
    const operators = [batchOperator("batchop.a", "acct.aaaaa")]
    expect(() =>
      EthereumOutpostSteps.resolveOppBootstrapSeed(
        operators,
        [["acct.aaaaa"], ["acct.zzzzz"]],
        0,
        SeedEpochDurationSec
      )
    ).toThrow(/acct\.zzzzz not found among provisioned batch operators/)
  })

  it("throws a DISTINCT error when a scheduled operator carries no Ethereum key", () => {
    const keyless = {
      ...batchOperator("batchop.a", "acct.aaaaa"),
      ethereum: undefined
    }
    expect(() =>
      EthereumOutpostSteps.resolveOppBootstrapSeed(
        [keyless],
        [["acct.aaaaa"]],
        0,
        SeedEpochDurationSec
      )
    ).toThrow(/acct\.aaaaa has no Ethereum key/)
  })
})

describe("EthereumOutpostSteps.assertSyndicationPoolConfigured", () => {
  let dataPath: string, panic: EthereumKeyPair

  beforeAll(() => {
    // The check reads the panic account off the PERSISTED panic wallet — the
    // random one the Ethereum outpost phase created under the cluster data dir.
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-outpost-steps-"))
    panic = EthereumWallet.saveWallet(
      dataPath,
      EthereumWallet.PanicWalletName,
      ethereumKeyPairFromWallet(ethers.Wallet.createRandom())
    )
  })

  afterAll(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  /** The configuration the deploy config names. */
  const configured = (): EthereumSyndicationTool.PoolConfiguration => ({
    maxSyndicationPerTransfer: ethers.parseEther("1000"),
    yieldDeadband: 10_000_000n,
    liqTokenCode: EthereumSyndicationTool.liqEthTokenCode(),
    liqTokenPrecision: 18
  })

  /** Answer the two reads the check makes. */
  function stubReads(
    configuration: EthereumSyndicationTool.PoolConfiguration,
    canCall: boolean
  ): jest.SpyInstance {
    jest
      .spyOn(EthereumSyndicationTool, "readPoolConfiguration")
      .mockResolvedValue(configuration)
    return jest
      .spyOn(EthereumSyndicationTool, "readCanCallPool")
      .mockResolvedValue(canCall)
  }

  it("accepts the deploy config's values and asks about the PERSISTED panic wallet for pause and unpause", async () => {
    const canCall = stubReads(configured(), true)
    await expect(
      EthereumOutpostSteps.assertSyndicationPoolConfigured(context({ dataPath }))
    ).resolves.toBeUndefined()
    expect(canCall.mock.calls.map(([, account, fn]) => [account, fn])).toEqual([
      [panic.address, EthereumSyndicationTool.PoolFunction.pause],
      [panic.address, EthereumSyndicationTool.PoolFunction.unpause]
    ])
  })

  it("refuses a pool whose maximum differs from the deploy config", async () => {
    stubReads({ ...configured(), maxSyndicationPerTransfer: 0n }, true)
    await expect(
      EthereumOutpostSteps.assertSyndicationPoolConfigured(context({ dataPath }))
    ).rejects.toThrow(/configuration is not what the deploy config named/)
  })

  it("refuses a pool reporting another liq token", async () => {
    stubReads({ ...configured(), liqTokenCode: 1n }, true)
    await expect(
      EthereumOutpostSteps.assertSyndicationPoolConfigured(context({ dataPath }))
    ).rejects.toThrow(/configuration is not what the deploy config named/)
  })

  it("refuses a panic account the access manager does not let pause", async () => {
    stubReads(configured(), false)
    await expect(
      EthereumOutpostSteps.assertSyndicationPoolConfigured(context({ dataPath }))
    ).rejects.toThrow(/may not call SyndicationPool\.pause\(\)/)
  })

  it("fails loudly when no panic wallet was persisted — the deploy's panic account cannot be named", async () => {
    const canCall = stubReads(configured(), true)
    await expect(
      EthereumOutpostSteps.assertSyndicationPoolConfigured(context())
    ).rejects.toThrow(/Ethereum wallet "panic" not found/)
    expect(canCall).not.toHaveBeenCalled()
  })
})
