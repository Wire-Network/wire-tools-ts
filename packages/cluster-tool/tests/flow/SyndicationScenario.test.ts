import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { AuthExLinkTool } from "@wireio/cluster-tool/tools/all"
import { Keypair } from "@solana/web3.js"
import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  AttestationType,
  ChainKind,
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope,
  OperatorType,
  SyndicateLIQ
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { Constants, ProtocolTiming } from "@wireio/cluster-tool/Constants"
import { SyndicationScenario } from "@wireio/cluster-tool/flow"
import {
  ClusterBuild,
  MockSyndicationBonderKey,
  Steps,
  SyndicationUserSteps,
  outputKey,
  type ClusterBuildPhase
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import {
  OperatorDaemonTool,
  WireSyndicationTool
} from "@wireio/cluster-tool/tools/wire"
import { SignatureProviderType } from "@wireio/cluster-tool-shared"
import { fixtureContext } from "../config/clusterBuildContextFixture.js"
import { PersistedFixture } from "../config/clusterConfigFixture.js"
import { fixtureOperatorAccount } from "../orchestration/outputs/operatorAccountFixture.js"

const UnderwriterExposureCap = "2.010000000 LIQSOL",
  signal = new AbortController().signal,
  { Actor } = Report,
  { SysioContractName } = SysioContracts,
  account = "synd.user"

/** Expose shared composition to exercise its production setup and cleanup boundaries. */
class Scenario extends SyndicationScenario {
  readonly name = "test-syndication"
  readonly description = "composition fixture"
  plan(cluster: ClusterBuild): void {
    this.planSetup(cluster, [{ account, keypairName: account, linked: false }])
    this.planFinish(cluster)
  }
}

/** Expose the underwriter start and the phase it registers. */
class UnderwriterScenario extends SyndicationScenario {
  readonly name = "test-underwriter"
  readonly description = "underwriter start fixture"
  /** The phase the last `plan` registered. */
  startPhase: ClusterBuildPhase
  plan(cluster: ClusterBuild): void {
    this.startPhase = this.planUnderwriterStart(cluster, UnderwriterExposureCap)
  }
}

afterEach(() => jest.restoreAllMocks())

describe("the bonder's underwriter daemon", () => {
  it("plans one phase: materialize the identity, then start its daemon", () => {
    const cluster = ClusterBuild.forContext(fixtureContext()),
      scenario = new UnderwriterScenario()
    scenario.plan(cluster)
    expect(cluster.children.map(child => child.name)).toEqual([
      "StartUnderwriter"
    ])
    const phase = scenario.startPhase
    expect(phase.steps.map(step => step.name)).toEqual([
      "materialize-underwriter",
      "start-underwriter"
    ])
    expect(phase.steps[0].runner).toBe(
      SyndicationScenario.runUnderwriterMaterialization
    )
    expect(phase.steps[1].runner).toBe(OperatorDaemonTool.runDaemonStart)
    expect(phase.steps[1].input).toEqual({
      kind: "OperatorDaemonTool.StartDaemonInput",
      label: Steps.registry.MockSyndicationBonderLabel,
      daemonOptions: { underwriterExposureCaps: [UnderwriterExposureCap] }
    })
  })

  it("refuses to plan the start on a cluster that reserved no port pair for the daemon", () => {
    const { bind } = PersistedFixture,
      cluster = ClusterBuild.forContext(
        fixtureContext({
          bind: {
            ...bind,
            nodeop: {
              ...bind.nodeop,
              ports: { ...bind.nodeop.ports, adHoc: [] }
            }
          }
        })
      )
    expect(SyndicationScenario.AdHocDaemonCount).toBe(1)
    expect(() => new UnderwriterScenario().plan(cluster)).toThrow(/adHocCount/)
    expect(cluster.children).toEqual([])
  })

  it("materializes the bonder as an underwriter with the account's key and its import keys", async () => {
    const ctx = fixtureContext(),
      { solana, ethereum } = fixtureOperatorAccount(
        Steps.registry.MockSyndicationBonderLabel,
        OperatorType.UNDERWRITER
      )
    ctx.outputs.set(MockSyndicationBonderKey, { solana, ethereum })
    await SyndicationScenario.runUnderwriterMaterialization(
      ctx,
      {
        kind: "SyndicationScenario.MaterializeUnderwriterInput",
        label: Steps.registry.MockSyndicationBonderLabel,
        account: SyndicationScenario.Bonder
      },
      signal
    )
    const underwriter = ctx.keyStore.assertOperator(
      Steps.registry.MockSyndicationBonderLabel
    )
    expect(underwriter).toEqual(
      expect.objectContaining({
        account: SyndicationScenario.Bonder,
        type: OperatorType.UNDERWRITER,
        solana,
        ethereum,
        // planSetup creates the bonder's account with the development key.
        wire: Constants.DEV_K1_KEY_PAIR
      })
    )
  })

  it("refuses to materialize an underwriter whose import keys were never made", async () => {
    const ctx = fixtureContext()
    await expect(
      SyndicationScenario.runUnderwriterMaterialization(
        ctx,
        {
          kind: "SyndicationScenario.MaterializeUnderwriterInput",
          label: Steps.registry.MockSyndicationBonderLabel,
          account: SyndicationScenario.Bonder
        },
        signal
      )
    ).rejects.toThrow(/has not been provisioned/)
    expect(
      ctx.keyStore.operator(Steps.registry.MockSyndicationBonderLabel)
    ).toBeUndefined()
  })

  it("plans the materialization as one Step naming the bonder's label and account", () => {
    const step = SyndicationScenario.planUnderwriterMaterialization(
      Actor.Underwriter,
      "materialize-underwriter",
      "materialize the bonder's underwriter identity",
      {}
    )
    expect(step.input).toEqual({
      kind: "SyndicationScenario.MaterializeUnderwriterInput",
      label: Steps.registry.MockSyndicationBonderLabel,
      account: SyndicationScenario.Bonder
    })
    expect(step.runner).toBe(SyndicationScenario.runUnderwriterMaterialization)
  })

  it("refuses to plan the start under a signature provider that cannot render the bonder's keys", () => {
    const cluster = ClusterBuild.forContext(
      fixtureContext({
        signatureProvider: { type: SignatureProviderType.KIOD, ssm: null }
      })
    )
    expect(() => new UnderwriterScenario().plan(cluster)).toThrow(
      /KEY signature provider/
    )
    expect(cluster.children).toEqual([])
  })

  it("gives each wait's Step the poll margin above the wait's own budget", () => {
    const FinalizerCount = 3,
      WindowSec = 120
    expect(SyndicationScenario.requestBondedOptions(FinalizerCount)).toEqual({
      timeoutMs:
        WireSyndicationTool.requestBondedBudgetMs(FinalizerCount) +
        ProtocolTiming.PollDeadlineBufferMs
    })
    expect(SyndicationScenario.underwriterPassOptions(FinalizerCount)).toEqual({
      timeoutMs:
        WireSyndicationTool.underwriterPassBudgetMs(FinalizerCount) +
        ProtocolTiming.PollDeadlineBufferMs
    })
    expect(
      SyndicationScenario.requestSettledOptions(WindowSec, FinalizerCount)
    ).toEqual({
      timeoutMs:
        WireSyndicationTool.requestSettledBudgetMs(WindowSec, FinalizerCount) +
        ProtocolTiming.PollDeadlineBufferMs
    })
    // Pinned once, so a change to the margin or a budget shows here: 591 s + 30 s.
    expect(
      SyndicationScenario.requestBondedOptions(FinalizerCount).timeoutMs
    ).toBe(621_000)
  })
})

describe("intake under a running underwriter daemon", () => {
  const Amount = 500_000_000n,
    AfterEpoch = 3,
    IntakeEpoch = 5,
    IntakeRequest = 3,
    after = outputKey<number>("test.after", "earlier epoch"),
    epoch = outputKey<number>("test.epoch", "intake epoch"),
    request = outputKey<SysioContracts.SysioBondApproveAction["request_id"]>(
      "test.request",
      "intake request"
    ),
    /** The released envelope of the unlinked recipient's syndication. */
    released: SysioContracts.SysioSyndEnvelopeRowType = {
      chain_code: SyndicationScenario.Chain,
      token_code: SyndicationScenario.Token,
      epoch_index: IntakeEpoch,
      digest: "00".repeat(32),
      synd_total: Amount.toString(),
      yield_total: 0,
      item_count: 1,
      state: SysioContracts.SysioSyndEnvelopeState.DONE,
      request_id: IntakeRequest,
      released: Amount.toString(),
      burned: 0,
      outcome: SysioContracts.SysioSyndRequestOutcome.APPROVED,
      forfeit: 0,
      bounty_returned: 0,
      hold_share: 0,
      hold_beneficiary: "",
      share_pending: false
    }

  /** The intake Step of the unlinked recipient. */
  function planIntake() {
    return SyndicationScenario.planVerifyIssuedIntake(
      Actor.Sysio,
      "unlinked-intake",
      "verify intake",
      {},
      {
        account: "synd.parked",
        keypairName: "syndication-parked",
        linked: false
      },
      Amount,
      after,
      epoch,
      request
    )
  }

  it("captures a released envelope's epoch and request, then still demands its attestation", async () => {
    const ctx = fixtureContext(),
      step = planIntake(),
      read = jest
        .spyOn(WireSyndicationTool, "readIssuedEnvelope")
        .mockResolvedValue(released)
    ctx.outputs.set(after, AfterEpoch)
    // No envelope artifact was written under the fixture's cluster path.
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
      "missing decoded syndication"
    )
    expect(read).toHaveBeenCalledWith(
      ctx,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      AfterEpoch,
      Amount
    )
    expect(ctx.outputs.assert(epoch)).toBe(IntakeEpoch)
    expect(ctx.outputs.assert(request)).toBe(IntakeRequest)
  })

  it("passes once the syndication circulated with custody covering it", async () => {
    const clusterPath = Fs.mkdtempSync(
        Path.join(Os.tmpdir(), "syndication-intake-test-")
      ),
      oppDirectory = oppDebuggingPath(clusterPath),
      ctx = fixtureContext({ clusterPath }),
      keypair = Keypair.generate(),
      step = planIntake(),
      // The outpost's SYNDICATE_LIQ of this amount and wallet, as the depot's
      // envelope artifact carries it.
      syndication = SyndicateLIQ.toBinary(
        SyndicateLIQ.create({
          user: { kind: ChainKind.SVM, address: keypair.publicKey.toBytes() },
          amount: { tokenCode: SyndicationScenario.TokenCode, amount: Amount },
          totalSyndicated: Amount
        })
      ),
      payload = Envelope.toBinary({
        envelopeHash: new Uint8Array(),
        epochTimestamp: 0n,
        epochIndex: IntakeEpoch,
        epochEnvelopeIndex: 0,
        previousEnvelopeHash: new Uint8Array(),
        messages: [
          {
            header: undefined,
            payload: {
              version: 0,
              attestations: [
                {
                  type: AttestationType.SYNDICATE_LIQ,
                  dataSize: syndication.length,
                  data: syndication
                }
              ]
            }
          }
        ]
      }),
      artifactKey = `${String(IntakeEpoch).padStart(8, "0")}-${DebugOutpostEndpointsType[DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT]}-abcdef0123456789`
    Fs.mkdirSync(oppDirectory, { recursive: true })
    Fs.writeFileSync(Path.join(oppDirectory, `${artifactKey}.data`), payload)
    Fs.writeFileSync(
      Path.join(oppDirectory, `${artifactKey}.metadata`),
      DebugEnvelopeMetadataRecord.toBinary({
        checksum: BigInt(payload.length),
        batchOpNames: []
      })
    )
    jest.spyOn(SolanaFundingTool, "loadKeypair").mockReturnValue(keypair)
    jest
      .spyOn(WireSyndicationTool, "readIssuedEnvelope")
      .mockResolvedValue(released)
    ctx.outputs.set(after, AfterEpoch)
    try {
      await step.runner(ctx, step.input, signal)
      expect(ctx.outputs.assert(epoch)).toBe(IntakeEpoch)
      expect(ctx.outputs.assert(request)).toBe(IntakeRequest)
    } finally {
      Fs.rmSync(clusterPath, { recursive: true, force: true })
    }
  })

  it("reads nothing before the earlier envelope's epoch is recorded", async () => {
    const ctx = fixtureContext(),
      step = planIntake(),
      read = jest
        .spyOn(WireSyndicationTool, "readIssuedEnvelope")
        .mockResolvedValue(released)
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(ctx.outputs.get(epoch)).toBeNull()
  })
})

describe("syndication scenario accounting", () => {
  it("plans setup and restoration without executing a write", () => {
    const cluster = ClusterBuild.forContext(fixtureContext())
    new Scenario().plan(cluster)
    expect(cluster.children.map(child => child.name)).toEqual([
      "SyndicationSetup",
      "RestoreAndVerify"
    ])
  })
  it("round trips base units without floating point, including dust", () => {
    expect(
      SyndicationScenario.units(SyndicationScenario.quantity(2_000_000_001n))
    ).toBe(2_000_000_001n)
    expect(SyndicationScenario.quantity(0n)).toBe("0.000000000 LIQSOL")
    expect(() => SyndicationScenario.quantity(-1n)).toThrow("negative")
  })
  it("uses the account as resource-policy owner", () => {
    expect(SyndicationScenario.resourcePolicy(account).owner).toBe(account)
    expect(SyndicationScenario.resourcePolicy(account).issuer).not.toBe(account)
  })
  it("treats absent holdings as zero and refuses truncated reads", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.liq)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
    const query = jest
      .spyOn(contract.tables.accounts, "query")
      .mockResolvedValue({ rows: [], more: false })
    expect(await SyndicationScenario.readBalance(ctx, account)).toBe(0n)
    query.mockResolvedValue({ rows: [], more: true })
    await expect(SyndicationScenario.readBalance(ctx, account)).rejects.toThrow(
      "truncated"
    )
  })
  it("reads the requested symbol rather than another holding", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.liq)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
    jest.spyOn(contract.tables.accounts, "query").mockResolvedValue({
      rows: [
        { balance: "9.000000000 LIQETH", index_checkpoint: "0", owed_wire: 0 },
        { balance: "2.000000001 LIQSOL", index_checkpoint: "0", owed_wire: 0 }
      ],
      more: false
    })
    expect(await SyndicationScenario.readBalance(ctx, account)).toBe(
      2_000_000_001n
    )
  })
  it("reads fees and handles a pot not yet created", async () => {
    const ctx = fixtureContext(),
      read = jest
        .spyOn(WireSyndicationTool, "readFeepot")
        .mockResolvedValue(undefined)
    expect(await SyndicationScenario.readFees(ctx)).toBe(0n)
    read.mockResolvedValue({
      token_code: SyndicationScenario.Token,
      balance: "123",
      position: { index_checkpoint: "0", owed_wire: 0 }
    })
    expect(await SyndicationScenario.readFees(ctx)).toBe(123n)
  })
  it("refuses an absent epoch singleton", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.epoch)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
    jest
      .spyOn(contract.tables.epochstate, "query")
      .mockResolvedValue({ rows: [], more: false })
    await expect(SyndicationScenario.readEpoch(ctx)).rejects.toThrow(
      "missing epoch"
    )
  })
  it("resolves runtime epochs and refuses a missing envelope", async () => {
    const ctx = fixtureContext(),
      key = outputKey<number>("test.epoch", "runtime epoch"),
      read = jest
        .spyOn(WireSyndicationTool, "readEnvelope")
        .mockResolvedValue(undefined)
    await expect(SyndicationScenario.readEnvelope(ctx, key)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    ctx.outputs.set(key, 7)
    await expect(SyndicationScenario.readEnvelope(ctx, key)).rejects.toThrow(
      "missing scenario envelope"
    )
    expect(read).toHaveBeenCalledWith(
      ctx,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      7
    )
  })
  it("restoration uses the captured configuration and never writes if it is missing", async () => {
    const ctx = fixtureContext(),
      step = SyndicationScenario.planRestoreConfig(
        Actor.Sysio,
        "restore",
        "restore",
        SyndicationScenario.WriteOptions
      ),
      run = jest
        .spyOn(Steps.contracts.sysio.synd, "runSetconfig")
        .mockResolvedValue()
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    const config: SysioContracts.SysioSyndSyndConfigType = {
      chain_code: SyndicationScenario.Chain,
      token_code: SyndicationScenario.Token,
      synd_fee_bps: 17,
      desynd_fee_bps: 23,
      synd_burst: 100,
      synd_refill: 3,
      desynd_burst: 200,
      desynd_refill: 4,
      window_sec: 60,
      bounty: 5,
      challenge_extra: 6,
      min_desyndicate: 1
    }
    ctx.outputs.set(SyndicationScenario.OriginalConfigKey, config)
    await step.runner(ctx, step.input, signal)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1].data).toEqual(config)
  })
  it("encodes the persisted wallet public key and fails when that wallet is missing", () => {
    const ctx = fixtureContext(),
      keypair = Keypair.generate(),
      load = jest
        .spyOn(SolanaFundingTool, "loadKeypair")
        .mockReturnValue(keypair)
    expect(
      SyndicationScenario.publicKey(ctx, {
        account,
        keypairName: account,
        linked: true
      })
    ).toBe(keypair.publicKey.toBuffer().toString("hex"))
    load.mockImplementation(() => {
      throw new Error("missing wallet")
    })
    expect(() =>
      SyndicationScenario.publicKey(ctx, {
        account,
        keypairName: account,
        linked: true
      })
    ).toThrow("missing wallet")
  })
  it("keeps the explicit crank as one existing contract step", () => {
    const step = SyndicationScenario.planCrank(
      Actor.User,
      "crank",
      "advance the syndication queue",
      SyndicationScenario.WriteOptions
    )
    expect(step.input.data.limit).toBe(SyndicationScenario.CrankLimit)
    expect(step.input.signer).toBe(SyndicationScenario.Bonder)
  })
})

describe("shared syndication user writes", () => {
  it("creates one policy and refuses an aborted write", async () => {
    const ctx = fixtureContext(),
      contract = ctx.wire.getSysioContract(SysioContractName.roa)
    jest.spyOn(ctx.wire, "getSysioContract").mockReturnValue(contract as never)
    const invoke = jest
        .spyOn(contract.actions.addpolicy, "invoke")
        .mockResolvedValue(undefined),
      step = SyndicationUserSteps.planResourcePolicy(
        Actor.User,
        "policy",
        "policy",
        {},
        SyndicationScenario.resourcePolicy(account)
      )
    await step.runner(ctx, step.input, signal)
    expect(invoke).toHaveBeenCalledTimes(1)
    await expect(
      step.runner(ctx, step.input, AbortSignal.abort())
    ).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it("links the persisted ED key in one createlink and refuses an absent wallet", async () => {
    const ctx = fixtureContext(),
      keypair = Keypair.generate(),
      load = jest
        .spyOn(SolanaFundingTool, "loadKeypair")
        .mockReturnValue(keypair),
      link = jest
        .spyOn(AuthExLinkTool, "createLink")
        .mockResolvedValue(undefined),
      step = SyndicationUserSteps.planLinkSolanaKey(
        Actor.User,
        "link",
        "link",
        {},
        account,
        account
      )
    await step.runner(ctx, step.input, signal)
    expect(link).toHaveBeenCalledTimes(1)
    expect(link.mock.calls[0][1].account).toBe(account)
    load.mockImplementation(() => {
      throw new Error("missing wallet")
    })
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
      "missing wallet"
    )
    expect(link).toHaveBeenCalledTimes(1)
  })
})
