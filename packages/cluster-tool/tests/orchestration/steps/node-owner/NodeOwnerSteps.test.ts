import { KeyType } from "@wireio/sdk-core"
import { KeyGenerator, NodeOwnerTier } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"

const { commit: CommitSteps, mint: MintSteps, registration: RegistrationSteps } =
  Steps.nodeOwner

/** A K1 key the registration steps carry. */
const OwnerKey = KeyGenerator.createSeeded(KeyType.K1, "node-owner-steps-test").publicKey

describe("Steps.nodeOwner.registration", () => {
  const signal = new AbortController().signal

  afterEach(() => jest.restoreAllMocks())

  it("createNamedUser carries the account, its key and tier", () => {
    const step = RegistrationSteps.planCreateNamedUser(
      Report.Actor.User,
      "create-gova",
      "create gova",
      {},
      "gova",
      OwnerKey,
      NodeOwnerTier.T1
    )
    expect(step.input).toEqual({
      kind: "NodeOwnerRegistrationSteps.CreateNamedUserInput",
      account: "gova",
      wirePublicKey: OwnerKey,
      tier: NodeOwnerTier.T1
    })
    expect(step.runner).toBe(RegistrationSteps.runCreateNamedUser)
  })

  it("runCreateNamedUser pushes ONE sysio.roa::newnameduser as sysio.roa", async () => {
    const ctx = fixtureContext(),
      invoke = jest.spyOn(ctx.wire, "invoke").mockResolvedValue(undefined)
    await RegistrationSteps.runCreateNamedUser(
      ctx,
      {
        kind: "NodeOwnerRegistrationSteps.CreateNamedUserInput",
        account: "gova",
        wirePublicKey: OwnerKey,
        tier: NodeOwnerTier.T1
      },
      signal
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(
      "sysio.roa",
      "newnameduser",
      { account: "gova", pubkey: OwnerKey, tier: NodeOwnerTier.T1 },
      [{ actor: "sysio.roa", permission: "active" }]
    )
  })

  it("runRegisterNodeOwner records a depositor key derived from the HD index", async () => {
    const ctx = fixtureContext(),
      invoke = jest.spyOn(ctx.wire, "invoke").mockResolvedValue(undefined),
      identity = await RegistrationSteps.newEthereumIdentity(ctx, 60)
    await RegistrationSteps.runRegisterNodeOwner(
      ctx,
      {
        kind: "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput",
        ownerAccount: "gova",
        tier: NodeOwnerTier.T1,
        ethereumHdIndex: 60,
        wirePublicKey: OwnerKey
      },
      signal
    )
    expect(invoke).toHaveBeenCalledWith(
      "sysio.roa",
      "nodeownreg",
      {
        owner: "gova",
        tier: NodeOwnerTier.T1,
        eth_pub_key: identity.publicKey,
        wire_pub_key: OwnerKey,
        eth_address: identity.nativeAddress
      },
      [{ actor: "sysio.roa", permission: "active" }]
    )
    // Distinct claims take distinct indices, so distinct depositor keys.
    expect((await RegistrationSteps.newEthereumIdentity(ctx, 61)).publicKey).not.toBe(
      identity.publicKey
    )
  })

  it("pushes nothing once the step is aborted", async () => {
    const ctx = fixtureContext(),
      invoke = jest.spyOn(ctx.wire, "invoke").mockResolvedValue(undefined)
    await expect(
      RegistrationSteps.runCreateNamedUser(
        ctx,
        {
          kind: "NodeOwnerRegistrationSteps.CreateNamedUserInput",
          account: "gova",
          wirePublicKey: OwnerKey,
          tier: NodeOwnerTier.T1
        },
        AbortSignal.abort()
      )
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("Steps.nodeOwner.mint + commit", () => {
  it("mint carries the tier and amount", () => {
    const step = MintSteps.planMint(
      Report.Actor.User,
      "mint",
      "mint one tier-1 unit",
      {},
      NodeOwnerTier.T1,
      1
    )
    expect(step.input).toEqual({
      kind: "NodeOwnerMintSteps.MintInput",
      tier: NodeOwnerTier.T1,
      amount: 1
    })
    expect(step.runner).toBe(MintSteps.runMint)
  })

  it("approveEscrow and commitNode carry their typed inputs", () => {
    const approve = CommitSteps.planApproveEscrow(
        Report.Actor.User,
        "approve-escrow",
        "approve BAR",
        {}
      ),
      commit = CommitSteps.planCommitNode(
        Report.Actor.User,
        "commit",
        "commit govd",
        {},
        NodeOwnerTier.T1,
        "govd",
        OwnerKey
      )
    expect(approve.input).toEqual({ kind: "NodeOwnerCommitSteps.ApproveEscrowInput" })
    expect(approve.runner).toBe(CommitSteps.runApproveEscrow)
    expect(commit.input).toEqual({
      kind: "NodeOwnerCommitSteps.CommitNodeInput",
      tier: NodeOwnerTier.T1,
      wireAccountName: "govd",
      wirePublicKey: OwnerKey
    })
    expect(commit.runner).toBe(CommitSteps.runCommitNode)
  })

  it("cannot resolve the outpost contracts before the daemon artifacts are published", () => {
    const ctx = fixtureContext()
    expect(() => MintSteps.resolveMockWireNodes(ctx)).toThrow()
    expect(() => CommitSteps.resolveBar(ctx)).toThrow()
  })

  it("commits nothing once the step is aborted", async () => {
    await expect(
      CommitSteps.runCommitNode(
        fixtureContext(),
        {
          kind: "NodeOwnerCommitSteps.CommitNodeInput",
          tier: NodeOwnerTier.T1,
          wireAccountName: "govd",
          wirePublicKey: OwnerKey
        },
        AbortSignal.abort()
      )
    ).rejects.toThrow()
  })
})
