import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, Name, SysioContracts } from "@wireio/sdk-core"
import { WireOperatorProvisioningTool } from "@wireio/cluster-tool/tools/wire"
import { Report } from "@wireio/cluster-tool/report"
import { Constants } from "@wireio/cluster-tool/Constants"
import {
  ClusterBuild,
  ClusterBuildPhase,
  type ClusterBuildContext,
  type ClusterBuildParent,
  type ClusterBuildPhaseBase,
  type ClusterBuildPhaseGroup,
  type StepInput
} from "@wireio/cluster-tool/orchestration"
import { type ExternalOutpostConfig } from "@wireio/cluster-tool-shared"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

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
function firstPhaseStepKinds(group: ClusterBuildPhaseGroup): string[] {
  const phase = group.children[0] as ClusterBuildPhase
  return phase.steps.map(step => (step.input as StepInput)?.kind ?? "")
}

describe("WireOperatorProvisioningTool.planOperatorAccountProvisioning", () => {
  it("returns a parallel PhaseGroup with one Phase per operator", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      fakeParent(),
      "Create ops",
      "provision ops",
      {},
      [
        { label: "batchopaaaa", type: OperatorType.BATCH, ethereumHdIndex: 1, isBootstrapped: true },
        { label: "uwritaaaaaa", type: OperatorType.UNDERWRITER, ethereumHdIndex: 2, isBootstrapped: false }
      ]
    )
    expect(group.config.parallel).toBe(true)
    expect(group.children.length).toBe(2)
    expect(group.children.map(child => child.name)).toEqual(["Provision batchopaaaa", "Provision uwritaaaaaa"])
  })

  it("a producer Phase materializes from its node + creates the account with ITS key (no authex/register)", () => {
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      fakeParent(),
      "Producers",
      "producers",
      {},
      [
        {
          label: "defproducera",
          type: OperatorType.PRODUCER,
          producerNodeIndex: 0,
          producerNodeName: "node_00"
        }
      ]
    )
    const kinds = firstPhaseStepKinds(group)
    expect(kinds).toEqual([
      "WireOperatorProvisioningTool.MaterializeProducerInput",
      "WireOperatorProvisioningTool.CreateAccountInput"
    ])
    const phase = group.children[0] as ClusterBuildPhase
    expect(phase.steps.map(step => step.actor)).toEqual([Report.Actor.Producer, Report.Actor.Producer])
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
/** The operator's DURABLE handle — the keystore key, never the sponsor nonce. */
const OperatorHandle = "batchopaaaa"
/** A FOREIGN sponsors row's nonce — never the one this operator's `newuser` minted. */
const DecoyNonce = "zzzzzzzzzzzz"
/** The account the foreign row carries — adopting it means the nonce predicate never ran. */
const DecoyAccount = "wireno.decoy"

/**
 * A REAL {@link ClusterBuildContext} whose `sponsors` table behaves like the
 * depot: a row appears ONLY for a nonce that `newuser` was actually called
 * with, AHEAD of it a foreign operator's row (the roster is shared, scoped to
 * the node owner) so the read-back's nonce predicate is genuinely exercised — a
 * read that returned `rows[0]` would adopt {@link DecoyAccount}. `emitRow` off
 * makes every read miss, which is how the "no row after newuser" case is
 * exercised without contriving a nonce value.
 *
 * Every double is a `jest.spyOn` against the real member it replaces, so the
 * doubled signatures are the shipped ones — a contract-client or key-store
 * change breaks this fixture instead of sliding past a hand-built stand-in.
 * `getSysioContract` mints a fresh Proxy (and a fresh invoker cache) per call,
 * so the two clients spied here are ALSO pinned as its return values.
 */
function fakeSponsorContext(emitRow = true) {
  const nonces: string[] = [],
    ctx = fixtureContext(),
    { keyStore } = ctx
  keyStore.setOperator({
    label: OperatorHandle,
    publicationLabel: OperatorHandle,
    type: OperatorType.BATCH,
    wire: { type: KeyType.K1, publicKey: "PUB_K1_op", privateKey: "PVT_K1_op" }
  })

  const roa = ctx.wire.getSysioContract(SysioContracts.SysioContractName.roa),
    opreg = ctx.wire.getSysioContract(SysioContracts.SysioContractName.opreg),
    newuserInvoke = jest.spyOn(roa.actions.newuser, "invoke").mockImplementation(async data => {
      nonces.push(data.nonce)
      return undefined
    }),
    regoperatorInvoke = jest.spyOn(opreg.actions.regoperator, "invoke").mockResolvedValue(undefined),
    sponsorsQuery = jest.spyOn(roa.tables.sponsors, "query").mockImplementation(async args => ({
      scope: args.scope,
      rows: emitRow
        ? [
            { nonce: DecoyNonce, username: DecoyAccount },
            ...nonces.map(nonce => ({ nonce, username: GeneratedAccount }))
          ]
        : [],
      more: false
    }))
  jest
    .spyOn(ctx.wire, "getSysioContract")
    .mockImplementation(name => (name === SysioContracts.SysioContractName.roa ? roa : opreg))
  return { ctx, keyStore, nonces, newuserInvoke, regoperatorInvoke, sponsorsQuery }
}

/** The step input every sponsored-creation test drives the runner with. */
const SponsoredInput = {
  kind: "WireOperatorProvisioningTool.SponsoredAccountCreationInput" as const,
  label: OperatorHandle
}

describe("WireOperatorProvisioningTool.runSponsoredAccountCreation", () => {
  it("invokes roa::newuser as the node owner and adopts the generated name into account", async () => {
    const { ctx, keyStore, newuserInvoke } = fakeSponsorContext()
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(ctx, SponsoredInput, new AbortController().signal)
    expect(newuserInvoke).toHaveBeenCalledTimes(1)
    const [data, options] = newuserInvoke.mock.calls[0]
    expect(data.creator).toBe(Constants.BOOTSTRAP_NODE_OWNER)
    expect(data.pubkey).toBe("PUB_K1_op")
    expect(options).toEqual({
      authorization: [{ actor: Constants.BOOTSTRAP_NODE_OWNER, permission: "active" }]
    })
    const operator = keyStore.assertOperator(OperatorHandle)
    // The read-back lands on account; the durable handle is untouched.
    expect(operator.account).toBe(GeneratedAccount)
    expect(operator.label).toBe(OperatorHandle)
  })

  it("passes a FRESH single-use nonce — never the operator's durable handle", async () => {
    const { ctx, newuserInvoke } = fakeSponsorContext()
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(ctx, SponsoredInput, new AbortController().signal)
    const [{ nonce }] = newuserInvoke.mock.calls[0]
    expect(nonce).not.toBe(OperatorHandle)
    expect(nonce).toMatch(/^[a-z1-5]{12}$/)
    expect(Name.isValid(nonce)).toBe(true)
  })

  it("mints a DIFFERENT nonce on every run (no reuse across operators)", async () => {
    const first = fakeSponsorContext(),
      second = fakeSponsorContext()
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      first.ctx,
      SponsoredInput,
      new AbortController().signal
    )
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(
      second.ctx,
      SponsoredInput,
      new AbortController().signal
    )
    expect(first.nonces[0]).not.toBe(second.nonces[0])
  })

  it("reads the sponsors table back BY THE MINTED NONCE, with an explicit row limit", async () => {
    const { ctx, keyStore, sponsorsQuery } = fakeSponsorContext()
    await WireOperatorProvisioningTool.runSponsoredAccountCreation(ctx, SponsoredInput, new AbortController().signal)
    // ONE read — the pre-check is gone, so the only query is the read-back.
    expect(sponsorsQuery).toHaveBeenCalledTimes(1)
    const [args] = sponsorsQuery.mock.calls[0]
    expect(args.scope).toBe(Constants.BOOTSTRAP_NODE_OWNER)
    expect(args.limit).toBeGreaterThan(0)
    // The foreign row precedes this operator's in the returned page, so the
    // adopted account proves the NONCE selected the row — a read that took
    // `rows[0]` (or dropped the predicate) would have adopted the decoy.
    const operator = keyStore.assertOperator(OperatorHandle)
    expect(operator.account).toBe(GeneratedAccount)
    expect(operator.account).not.toBe(DecoyAccount)
  })

  it("propagates a failed sponsors read instead of treating it as 'no row yet'", async () => {
    const { ctx, sponsorsQuery } = fakeSponsorContext()
    sponsorsQuery.mockRejectedValueOnce(
      new Error("Contract Table Query Exception: Table sponsors is not specified in the ABI")
    )
    await expect(
      WireOperatorProvisioningTool.runSponsoredAccountCreation(ctx, SponsoredInput, new AbortController().signal)
    ).rejects.toThrow(/Contract Table Query Exception/)
  })

  it("throws when no sponsors row exists for the minted nonce after newuser", async () => {
    const { ctx } = fakeSponsorContext(false)
    await expect(
      WireOperatorProvisioningTool.runSponsoredAccountCreation(ctx, SponsoredInput, new AbortController().signal)
    ).rejects.toThrow(/no sponsors row for nonce/)
  })
})

describe("WireOperatorProvisioningTool.runRegistration", () => {
  it("registers the operator's RESOLVED account, not its durable handle", async () => {
    const { ctx, keyStore, regoperatorInvoke } = fakeSponsorContext()
    keyStore.setOperator({
      ...keyStore.assertOperator(OperatorHandle),
      account: GeneratedAccount
    })
    await WireOperatorProvisioningTool.runRegistration(
      ctx,
      {
        kind: "WireOperatorProvisioningTool.RegistrationInput",
        label: OperatorHandle,
        type: OperatorType.BATCH,
        isBootstrapped: true
      },
      new AbortController().signal
    )
    expect(regoperatorInvoke).toHaveBeenCalledTimes(1)
    // `account:` is the GENERATED ABI field on `opreg::regoperator` — it never
    // renames with the harness, and it carries the on-chain account.
    const [data] = regoperatorInvoke.mock.calls[0]
    expect(data.account).toBe(GeneratedAccount)
    expect(data.account).not.toBe(OperatorHandle)
    expect(data.is_bootstrapped).toBe(true)
    expect(data.type).toBe(SysioContracts.SysioOpregOperatortype.OPERATOR_TYPE_BATCH)
  })
})

describe("planOperatorAccountProvisioning — outpost-chain funding gate (H3)", () => {
  const FundedSpec = {
    label: "depositoraaa",
    type: OperatorType.BATCH,
    ethereumHdIndex: 35,
    isBootstrapped: false,
    fundEthereumWei: 10n ** 18n,
    airdropSolanaLamports: 5_000_000_000n
  }

  /** Provision a funded batch op over a REAL context (the gate reads config). */
  function fundedKinds(externalOutposts?: ExternalOutpostConfig): string[] {
    const cluster = ClusterBuild.forContext(fixtureContext(externalOutposts != null ? { externalOutposts } : {}))
    const group = WireOperatorProvisioningTool.planOperatorAccountProvisioning(cluster, "ops", "ops", {}, [FundedSpec])
    return firstPhaseStepKinds(group)
  }

  it("INCLUDES fund + airdrop in local mode", () => {
    const kinds = fundedKinds()
    expect(kinds).toContain("WireOperatorProvisioningTool.FundEthereumInput")
    expect(kinds).toContain("WireOperatorProvisioningTool.AirdropSolanaInput")
  })

  it("GATES OUT fund + airdrop in external-outpost mode (depot-side steps stay)", () => {
    const kinds = fundedKinds({
      ethereum: { addressFile: "outpost-addrs.json", abiFiles: [], chainId: 1 },
      solana: { idlFile: "idl.json" }
    })
    expect(kinds).not.toContain("WireOperatorProvisioningTool.FundEthereumInput")
    expect(kinds).not.toContain("WireOperatorProvisioningTool.AirdropSolanaInput")
    // every depot-side step still runs.
    expect(kinds).toContain("WireOperatorProvisioningTool.SponsoredAccountCreationInput")
    expect(kinds).toContain("WireOperatorProvisioningTool.RegistrationInput")
  })
})
