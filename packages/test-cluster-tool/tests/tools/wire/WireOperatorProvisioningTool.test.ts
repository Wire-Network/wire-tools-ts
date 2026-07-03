import { OperatorType } from "@wireio/opp-typescript-models"
import { WireOperatorProvisioningTool } from "@wireio/test-cluster-tool/tools/wire"
import { Report } from "@wireio/test-cluster-tool/report"
import {
  ClusterBuildPhase,
  type ClusterBuildContext,
  type ClusterBuildParent,
  type ClusterBuildPhaseBase
} from "@wireio/test-cluster-tool/orchestration"

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
      { account: "batchopaaaa", type: OperatorType.BATCH, ethereumHdIndex: 1, isBootstrapped: true },
      { account: "uwritaaaaaa", type: OperatorType.UNDERWRITER, ethereumHdIndex: 2, isBootstrapped: false }
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
      { account: "defproducera", type: OperatorType.PRODUCER, producerNodeIndex: 0 }
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

  it("a bootstrap batch/uw Phase (no funding) skips fund + airdrop, authex-links both chains, registers", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "ops", "ops", {}, [
      { account: "batchopaaaa", type: OperatorType.BATCH, ethereumHdIndex: 1, isBootstrapped: true }
    ])
    const kinds = firstPhaseStepKinds(group)
    expect(kinds).toEqual([
      "WireOperatorProvisioningTool.MaterializeIdentityInput",
      "WireOperatorProvisioningTool.CreateAccountInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "WireOperatorProvisioningTool.AuthexLinkInput",
      "OperatorSteps.RegisterInput"
    ])
  })

  it("a flow op WITH funding includes fund + airdrop steps", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(fakeParent(), "flow", "flow", {}, [
      {
        account: "depositoraaa",
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
