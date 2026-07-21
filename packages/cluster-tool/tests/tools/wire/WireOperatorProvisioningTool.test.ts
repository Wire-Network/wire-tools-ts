import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { WireOperatorProvisioningTool } from "@wireio/cluster-tool/tools/wire"
import { Report } from "@wireio/cluster-tool/report"
import { Constants } from "@wireio/cluster-tool/Constants"
import {
  ClusterBuildPhase,
  ClusterKeyStore,
  type ClusterBuildContext,
  type ClusterBuildParent,
  type ClusterBuildPhaseBase
} from "@wireio/cluster-tool/orchestration"

/** A minimal parent that captures pushed children (no context needed for structure). */
function fakeParent<C extends ClusterBuildContext = ClusterBuildContext>(): ClusterBuildParent<C> {
  const parent: ClusterBuildParent<C> = {
    context: {} as C,
    push(..._children: ClusterBuildPhaseBase<C>[]) {
      return parent
    }
  }
  return parent
}

/** The `input.kind` of every step in a group's first phase. */
function firstPhaseStepKinds(group: { children: ReadonlyArray<ClusterBuildPhaseBase> }): string[] {
  const phase = group.children[0] as ClusterBuildPhase
  return phase.steps.map(step => (step.input as { kind?: string } | null)?.kind ?? "")
}

describe("WireOperatorProvisioningTool.planOperatorAccountProvisioning", () => {
  it("returns a parallel PhaseGroup with one Phase per operator", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "Create ops", "provision ops", {}, [
      { label: "batchopaaaa", type: OperatorType.BATCH, ethereumHdIndex: 1, isBootstrapped: true },
      { label: "uwritaaaaaa", type: OperatorType.UNDERWRITER, ethereumHdIndex: 2, isBootstrapped: false }
    ])
    expect(group.config.parallel).toBe(true)
    expect(group.children.length).toBe(2)
    expect(group.children.map(child => child.name)).toEqual([
      "Provision batchopaaaa",
      "Provision uwritaaaaaa"
    ])
  })

  it("a producer Phase materializes from its node + creates the account with ITS key (no authex/register)", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "Producers", "producers", {}, [
      { label: "defproducera", type: OperatorType.PRODUCER, producerNodeIndex: 0 }
    ])
    const kinds = firstPhaseStepKinds(group)
    expect(kinds).toEqual([
      "WireOperatorProvisioningTool.MaterializeProducerInput",
      "WireOperatorProvisioningTool.CreateAccountInput"
    ])
    const phase = group.children[0] as ClusterBuildPhase
    expect(phase.steps.map(step => step.actor)).toEqual([
      Report.Actor.Producer,
      Report.Actor.Producer
    ])
  })

  it("a bootstrap batch/uw Phase (no funding) sponsors the account, authex-links both chains, registers", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "ops", "ops", {}, [
      { label: "batchopaaaa", type: OperatorType.BATCH, ethereumHdIndex: 1, isBootstrapped: true }
    ])
    const kinds = firstPhaseStepKinds(group)
    expect(kinds).toEqual([
      "WireOperatorProvisioningTool.MaterializeIdentityInput",
      "WireOperatorProvisioningTool.SponsoredAccountCreationInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.RegistrationInput"
    ])
  })

  it("a flow op WITH funding includes fund + airdrop steps", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "flow", "flow", {}, [
      {
        label: "depositoraaa",
        type: OperatorType.BATCH,
        ethereumHdIndex: 35,
        isBootstrapped: false,
        fundEthereumWei: 10n ** 18n,
        airdropSolanaLamports: 5_000_000_000n
      }
    ])
    const kinds = firstPhaseStepKinds(group)
    expect(kinds).toContain("WireOperatorProvisioningTool.FundEthereumInput")
    expect(kinds).toContain("WireOperatorProvisioningTool.AirdropSolanaInput")
  })
})

/** A generated `wireno.<suffix>`-style chain account for the sponsored-creation tests. */
const GeneratedAccount = "wireno.x3f9k"
const OperatorLabel = "batchopaaaa"

/** Seed a key store holding one materialized (pre-creation) OPP operator. */
function seededKeyStore(): ClusterKeyStore {
  return new ClusterKeyStore().setOperator({
    label: OperatorLabel,
    account: OperatorLabel,
    type: OperatorType.BATCH,
    wire: { type: KeyType.K1, publicKey: "PUB_K1_op", privateKey: "PVT_K1_op" }
  })
}

/** A fake typed-contract ctx: `roa` sponsors query + newuser invoke, `opreg` regoperator invoke. */
function fakeSponsorContext(sponsorRowsPerQuery: Array<Array<{ nonce: string; username: string }>>) {
  const newuserInvoke = jest.fn().mockResolvedValue({}),
    regoperatorInvoke = jest.fn().mockResolvedValue({}),
    sponsorsQuery = jest.fn(async () => ({
      rows: sponsorRowsPerQuery.shift() ?? [],
      more: false
    })),
    keyStore = seededKeyStore(),
    ctx = {
      keyStore,
      wire: {
        getSysioContract: (name: string) =>
          name === "roa"
            ? {
                actions: { newuser: { invoke: newuserInvoke } },
                tables: { sponsors: { query: sponsorsQuery } }
              }
            : { actions: { regoperator: { invoke: regoperatorInvoke } } }
      }
    } as unknown as ClusterBuildContext
  return { ctx, keyStore, newuserInvoke, regoperatorInvoke, sponsorsQuery }
}

describe("WireOperatorProvisioningTool.runSponsoredAccountCreation", () => {
  it("invokes roa::newuser as the node owner and adopts the generated sponsors username", async () => {
    const { ctx, keyStore, newuserInvoke } = fakeSponsorContext([
      [],
      [{ nonce: OperatorLabel, username: GeneratedAccount }]
    ])
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      ctx,
      { kind: "WireOperatorProvisioningTool.SponsoredAccountCreationInput", label: OperatorLabel },
      new AbortController().signal
    )
    expect(newuserInvoke).toHaveBeenCalledTimes(1)
    expect(newuserInvoke).toHaveBeenCalledWith(
      {
        creator: Constants.BOOTSTRAP_NODE_OWNER,
        nonce: OperatorLabel,
        pubkey: "PUB_K1_op"
      },
      {
        authorization: [
          { actor: Constants.BOOTSTRAP_NODE_OWNER, permission: "active" }
        ]
      }
    )
    const operator = keyStore.assertOperator(OperatorLabel)
    expect(operator.account).toBe(GeneratedAccount)
    expect(operator.label).toBe(OperatorLabel)
  })

  it("adopts an existing sponsors row without a second newuser (re-entrant)", async () => {
    const { ctx, keyStore, newuserInvoke } = fakeSponsorContext([
      [{ nonce: OperatorLabel, username: GeneratedAccount }]
    ])
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      ctx,
      { kind: "WireOperatorProvisioningTool.SponsoredAccountCreationInput", label: OperatorLabel },
      new AbortController().signal
    )
    expect(newuserInvoke).not.toHaveBeenCalled()
    expect(keyStore.assertOperator(OperatorLabel).account).toBe(GeneratedAccount)
  })

  it("treats a rejected sponsors read (never-written KV table) as no-row and still creates", async () => {
    const { ctx, keyStore, newuserInvoke, sponsorsQuery } = fakeSponsorContext([
      [{ nonce: OperatorLabel, username: GeneratedAccount }]
    ])
    sponsorsQuery.mockRejectedValueOnce(
      new Error("Contract Table Query Exception: Table sponsors is not specified in the ABI")
    )
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      ctx,
      { kind: "WireOperatorProvisioningTool.SponsoredAccountCreationInput", label: OperatorLabel },
      new AbortController().signal
    )
    expect(newuserInvoke).toHaveBeenCalledTimes(1)
    expect(keyStore.assertOperator(OperatorLabel).account).toBe(GeneratedAccount)
  })

  it("throws when no sponsors row exists for the nonce after newuser", async () => {
    const { ctx } = fakeSponsorContext([[], []])
    await expect(
      WireOperatorProvisioningTool.runSponsoredAccountCreation(
        ctx,
        { kind: "WireOperatorProvisioningTool.SponsoredAccountCreationInput", label: OperatorLabel },
        new AbortController().signal
      )
    ).rejects.toThrow(/no sponsors row for nonce "batchopaaaa"/)
  })
})

describe("WireOperatorProvisioningTool.runRegistration", () => {
  it("registers the operator's RESOLVED generated account, not its label", async () => {
    const { ctx, keyStore, regoperatorInvoke } = fakeSponsorContext([
      [],
      [{ nonce: OperatorLabel, username: GeneratedAccount }]
    ])
    keyStore.setOperator({
      ...keyStore.assertOperator(OperatorLabel),
      account: GeneratedAccount
    })
    await WireOperatorProvisioningTool.runRegistration(
      ctx,
      {
        kind: "WireOperatorProvisioningTool.RegistrationInput",
        label: OperatorLabel,
        type: OperatorType.BATCH,
        isBootstrapped: true
      },
      new AbortController().signal
    )
    expect(regoperatorInvoke).toHaveBeenCalledTimes(1)
    const [data] = regoperatorInvoke.mock.calls[0]
    expect(data.account).toBe(GeneratedAccount)
    expect(data.is_bootstrapped).toBe(true)
    expect(data.type).toBeDefined()
  })
})
