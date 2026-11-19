import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { EthereumFundingTool, KeyGenerator, NodeOwnerTier } from "@wireio/cluster-tool"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../../config/clusterBuildContextFixture.js"

const { commit: CommitSteps, mint: MintSteps, registration: RegistrationSteps } =
  Steps.nodeOwner

/** A K1 key the registration steps carry. */
const OwnerKey = PrivateKey.generate(KeyType.K1).toPublic().toString()
/** Durable handle of a claim's depositor wallet. */
const DepositorWalletName = "node-owner-steps-gova"
/** A second claim's depositor wallet handle. */
const OtherDepositorWalletName = "node-owner-steps-govb"
/** What a test depositor wallet is for. */
const DepositorPurpose = "node-owner steps test — depositor wallet"

describe("Steps.nodeOwner.registration", () => {
  const signal = new AbortController().signal
  let dataPath: string

  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "node-owner-steps-"))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  /** Persist a random depositor wallet under `walletName` in the test's data directory. */
  function createDepositorWallet(walletName: string) {
    return EthereumFundingTool.createWallet(
      dataPath,
      walletName,
      KeyGenerator.context(),
      DepositorPurpose
    )
  }

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

  it("registerNodeOwner carries the owner, tier, depositor wallet handle and Wire key", () => {
    const step = RegistrationSteps.planRegisterNodeOwner(
      Report.Actor.User,
      "register-gova",
      "register gova",
      {},
      "gova",
      NodeOwnerTier.T1,
      DepositorWalletName,
      OwnerKey
    )
    expect(step.input).toEqual({
      kind: "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput",
      ownerAccount: "gova",
      tier: NodeOwnerTier.T1,
      walletName: DepositorWalletName,
      wirePublicKey: OwnerKey
    })
    expect(step.runner).toBe(RegistrationSteps.runRegisterNodeOwner)
  })

  it("loadDepositorIdentity reads the persisted wallet back: its EM key and raw address", async () => {
    const ctx = fixtureContext({ dataPath }),
      wallet = await createDepositorWallet(DepositorWalletName),
      identity = RegistrationSteps.loadDepositorIdentity(ctx, DepositorWalletName)
    expect(identity).toEqual({
      publicKey: wallet.publicKey,
      nativeAddress: wallet.address.slice(2).toLowerCase()
    })
    expect(RegistrationSteps.loadDepositorPublicKey(ctx, DepositorWalletName)).toBe(
      wallet.publicKey
    )
    expect(() =>
      RegistrationSteps.loadDepositorIdentity(ctx, OtherDepositorWalletName)
    ).toThrow(/not found/)
  })

  it("runRegisterNodeOwner records the claim's persisted depositor key", async () => {
    const ctx = fixtureContext({ dataPath }),
      invoke = jest.spyOn(ctx.wire, "invoke").mockResolvedValue(undefined),
      wallet = await createDepositorWallet(DepositorWalletName),
      other = await createDepositorWallet(OtherDepositorWalletName)
    await RegistrationSteps.runRegisterNodeOwner(
      ctx,
      {
        kind: "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput",
        ownerAccount: "gova",
        tier: NodeOwnerTier.T1,
        walletName: DepositorWalletName,
        wirePublicKey: OwnerKey
      },
      signal
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(
      "sysio.roa",
      "nodeownreg",
      {
        owner: "gova",
        tier: NodeOwnerTier.T1,
        eth_pub_key: wallet.publicKey,
        wire_pub_key: OwnerKey,
        eth_address: wallet.address.slice(2).toLowerCase()
      },
      [{ actor: "sysio.roa", permission: "active" }]
    )
    // Distinct claims carry distinct persisted wallets, so distinct depositor keys.
    expect(other.publicKey).not.toBe(wallet.publicKey)
  })

  it("runRegisterNodeOwner pushes nothing for a wallet no step persisted", async () => {
    const ctx = fixtureContext({ dataPath }),
      invoke = jest.spyOn(ctx.wire, "invoke").mockResolvedValue(undefined)
    await expect(
      RegistrationSteps.runRegisterNodeOwner(
        ctx,
        {
          kind: "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput",
          ownerAccount: "gova",
          tier: NodeOwnerTier.T1,
          walletName: DepositorWalletName,
          wirePublicKey: OwnerKey
        },
        signal
      )
    ).rejects.toThrow(/not found/)
    expect(invoke).not.toHaveBeenCalled()
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
