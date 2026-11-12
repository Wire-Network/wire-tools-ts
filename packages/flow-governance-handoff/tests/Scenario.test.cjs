const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { KeyType } = require("@wireio/sdk-core")
const {
  ClusterBuild,
  Constants: HarnessConstants,
  KeyGenerator,
  NodeOwnerTier,
  OutputStore,
  Steps,
  supermajorityThreshold
} = require("@wireio/cluster-tool")
const Scenario = require("../lib/GovernanceHandoffScenario.js")
const {
  GovernanceHandoffScenarioConstants: Constants
} = require("../lib/GovernanceHandoffScenarioConstants.js")

afterEach(() => mock.restoreAll())

/** A context whose outputs are a live map and whose WIRE reads are stubbed per test. */
function contextWith(wire = {}) {
  const values = new Map()
  return {
    wire,
    outputs: {
      set: (key, value) => values.set(key.name, value),
      get: key => values.get(key.name),
      assert: key => {
        Assert.ok(values.has(key.name), `missing ${key.name}`)
        return values.get(key.name)
      }
    }
  }
}

/** A WIRE client whose tier-1 roster is `roster` and whose `sysio.nodes@active` is `active`. */
function rosterWire(roster, active) {
  return {
    getSysioContract: () => ({
      tables: {
        roastate: { query: async () => ({ rows: [{ network_gen: 0 }] }) },
        nodeowners: { queryAll: async () => roster.map(owner => ({ owner, tier: 1 })) }
      }
    }),
    api: {
      v1: {
        chain: {
          get_account: async () => ({
            account_name: "sysio.nodes",
            permissions: [{ perm_name: "active", parent: "owner", required_auth: active }]
          })
        }
      }
    }
  }
}

test("the flow's counts give 2 of 2, then 3 of 3, then 3 of 4: the late owner leaves the threshold unchanged", () => {
  Assert.equal(supermajorityThreshold(Constants.PreSyncNodeOwners.length), 2)
  Assert.equal(
    supermajorityThreshold(Constants.InitialNodeOwners.length),
    Constants.InitialNodeOwners.length
  )
  Assert.equal(supermajorityThreshold(Constants.NodeOwners.length), 3)
  Assert.deepEqual(
    [...Constants.InitialNodeOwners],
    [...Constants.PreSyncNodeOwners, Constants.HandoffNodeOwner]
  )
  Assert.deepEqual([...Constants.NodeOwners], [...Constants.InitialNodeOwners, Constants.LateNodeOwner])
})

test("every flow identity has its own seeded key, none of them the bootstrap key", () => {
  const keys = [...Constants.NodeOwners, ...Constants.CouncilMembers].map(Scenario.flowPublicKey)
  Assert.equal(new Set(keys).size, keys.length)
  keys.forEach(key =>
    Assert.notEqual(key, KeyGenerator.createSeeded(KeyType.K1, KeyGenerator.BiosK1KeySeed).publicKey)
  )
  Assert.equal(
    Scenario.flowPublicKey("gova"),
    KeyGenerator.createSeeded(KeyType.K1, Constants.keySeed("gova")).publicKey
  )
})

test("an initial owner is one nodeownreg claim under its own key, then a read-back", () => {
  const steps = Scenario.planInitialOwner("gova", Constants.FirstDepositorEthereumHdIndex)
  Assert.deepEqual(
    steps.map(step => step.name),
    ["register-gova", "registered-gova"]
  )
  Assert.deepEqual(steps[0].input, {
    kind: "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput",
    ownerAccount: "gova",
    tier: NodeOwnerTier.T1,
    ethereumHdIndex: Constants.FirstDepositorEthereumHdIndex,
    wirePublicKey: Scenario.flowPublicKey("gova")
  })
})

test("the plan creates no owner account before its claim: only the stand-in council is created", () => {
  const build = ClusterBuild.forContext({ outputs: new OutputStore() })
  new Scenario.GovernanceHandoffScenario().plan(build)
  const steps = build.children.flatMap(phase => phase.steps),
    kinds = new Set(steps.map(step => step.input?.kind)),
    claims = steps.filter(
      step => step.input?.kind === "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput"
    ),
    created = steps.filter(step => step.input?.kind === "AccountSteps.CreateKeyedInput")
  Assert.ok(!kinds.has("NodeOwnerRegistrationSteps.CreateNamedUserInput"))
  Assert.deepEqual(
    claims.map(step => step.input.ownerAccount),
    [...Constants.InitialNodeOwners]
  )
  Assert.deepEqual(
    claims.map(step => step.input.ethereumHdIndex),
    Constants.InitialNodeOwners.map((_, index) => Constants.FirstDepositorEthereumHdIndex + index)
  )
  Assert.deepEqual(
    created.map(step => step.input.account),
    [...Constants.CouncilMembers]
  )
  const commit = steps.find(step => step.input?.kind === "NodeOwnerCommitSteps.CommitNodeInput")
  Assert.equal(commit.input.wireAccountName, Constants.LateNodeOwner)
  Assert.equal(commit.input.wirePublicKey, Scenario.flowPublicKey(Constants.LateNodeOwner))
})

test("a probe transfer is a typed sysio.token::transfer of one WIRE from sysio, declared by sysio@active", () => {
  Assert.deepEqual(Scenario.probeTransfer("cnla"), {
    contract: "token",
    account: "sysio.token",
    name: "transfer",
    authorization: [{ actor: "sysio", permission: "active" }],
    data: {
      from: "sysio",
      to: "cnla",
      quantity: "1.000000000 WIRE",
      memo: Constants.ProbeTransferMemo
    }
  })
})

test("the stand-in council is written to sysio.cncl@active by sysio.cncl@owner at its supermajority", () => {
  const action = Scenario.setCouncilAction()
  Assert.equal(action.name, "updateauth")
  Assert.deepEqual(action.authorization, [{ actor: "sysio.cncl", permission: "owner" }])
  Assert.equal(action.data.account, HarnessConstants.COUNCIL_AUTHORITY)
  Assert.equal(action.data.permission, "active")
  Assert.equal(action.data.parent, "owner")
  Assert.equal(action.data.auth.threshold, 3)
  Assert.deepEqual(
    action.data.auth.accounts.map(entry => entry.permission.actor),
    [...Constants.CouncilMembers]
  )
})

test("every probe proposal is executed by the first owner, and approvers sign their own active", () => {
  Assert.deepEqual(Scenario.execData("probe"), {
    proposer: "gova",
    proposal_name: "probe",
    executer: "gova"
  })
  Assert.deepEqual(Scenario.activeLevels(["gova", "govb"]), [
    { actor: "gova", permission: "active" },
    { actor: "govb", permission: "active" }
  ])
  const [approval] = Scenario.planApprovals("probe", ["govb"])
  Assert.deepEqual(approval.input.data, {
    proposer: "gova",
    proposal_name: "probe",
    level: { actor: "govb", permission: "active" }
  })
  Assert.deepEqual(Scenario.planProposal("probe", ["gova"], [], "probe").input.data, {
    proposer: "gova",
    proposal_name: "probe",
    requested: [{ actor: "gova", permission: "active" }]
  })
})

test("after the handoff the roster must be exactly the initial owners", async () => {
  const ctx = contextWith()
  ctx.outputs.set(Scenario.SyncedRosterKey, ["gova", "govb", "govc"])
  await Scenario.assertFlowOwnersMeetThreshold(ctx)
  // A tier-1 owner the flow did not register would move the threshold its probes count against.
  ctx.outputs.set(Scenario.SyncedRosterKey, ["gova", "govb", "govc", "outsider"])
  await Assert.rejects(
    Scenario.assertFlowOwnersMeetThreshold(ctx),
    /\[gova, govb, govc, outsider\] must be exactly the flow's owners \[gova, govb, govc\]/
  )
  // ...and so would a missing one.
  ctx.outputs.set(Scenario.SyncedRosterKey, ["gova", "govb"])
  await Assert.rejects(Scenario.assertFlowOwnersMeetThreshold(ctx), /must be exactly the flow's owners/)
})

test("refusal checks read a dry-run exec and never push", async () => {
  const ctx = contextWith({}),
    isExecutable = mock.method(Steps.contracts.sysio.msig, "isExecutable", async () => false)
  await Scenario.assertExecutable(ctx, "probe", false)
  Assert.deepEqual(isExecutable.mock.calls[0].arguments[1], Scenario.execData("probe"))
  await Assert.rejects(Scenario.assertExecutable(ctx, "probe", true), /must be executable now/)
})

test("the late owner's re-sync must make the roster every flow owner and keep the threshold", async () => {
  const ctx = contextWith({})
  // 3 → 4 owners: 3 of 3, then 3 of 4.
  ctx.outputs.set(Scenario.PreviousRosterKey, ["gova", "govb", "govc"])
  ctx.outputs.set(Scenario.SyncedRosterKey, ["gova", "govb", "govc", "govd"])
  await Scenario.assertLateOwnerKeepsThreshold(ctx)
  // A roster beyond the flow's owners fails before any threshold is compared.
  ctx.outputs.set(Scenario.SyncedRosterKey, ["gova", "govb", "govc", "govd", "outsider"])
  await Assert.rejects(Scenario.assertLateOwnerKeepsThreshold(ctx), /must be exactly the flow's owners/)
  // 2 → 4 owners: 2 of 2, then 3 of 4 — the threshold moved.
  ctx.outputs.set(Scenario.PreviousRosterKey, ["gova", "govb"])
  ctx.outputs.set(Scenario.SyncedRosterKey, ["gova", "govb", "govc", "govd"])
  await Assert.rejects(
    Scenario.assertLateOwnerKeepsThreshold(ctx),
    /must leave the threshold unchanged: 2 of 2, now 3 of 4/
  )
})

test("the node owners' refusal to propose is a dry run, never a push", async () => {
  const ctx = contextWith({}),
    isProposable = mock.method(Steps.contracts.sysio.msig, "isProposable", async () => false)
  await Scenario.assertNodeOwnersCannotPropose(ctx)
  Assert.equal(isProposable.mock.calls[0].arguments[1].data.proposal_name, Constants.RefusedProposal)
  mock.method(Steps.contracts.sysio.msig, "isProposable", async () => true)
  await Assert.rejects(Scenario.assertNodeOwnersCannotPropose(ctx), /must not be able to propose/)
})

test("sysio.nodes@active must equal the roster; the check records the roster it replaced", async () => {
  const roster = ["gova", "govb", "govc"],
    ctx = contextWith(rosterWire(roster, Steps.governance.supermajorityAuthority([...roster])))
  ctx.outputs.set(Scenario.SyncedRosterKey, ["gova", "govb"])
  await Scenario.assertNodeOwnerAuthorityIsRoster(ctx)
  Assert.deepEqual(ctx.outputs.assert(Scenario.SyncedRosterKey), roster)
  Assert.deepEqual(ctx.outputs.assert(Scenario.PreviousRosterKey), ["gova", "govb"])
  // A registration after the last syncnodes: the authority no longer equals the roster.
  roster.push("govd")
  await Assert.rejects(Scenario.assertNodeOwnerAuthorityIsRoster(ctx), /must be the tier-1 roster/)
})

test("the handoff's syncnodes is observable: the owner registered after the last sync joins only through it", async () => {
  const full = ["gova", "govb", "govc"],
    synced = contextWith(rosterWire(full, Steps.governance.supermajorityAuthority(full)))
  synced.outputs.set(Scenario.SyncedRosterKey, ["gova", "govb"])
  await Scenario.assertHandoffSyncedRoster(synced)
  // The roster before the handoff already held the handoff owner: nothing proves the in-transaction sync.
  const presynced = contextWith(rosterWire(full, Steps.governance.supermajorityAuthority(full)))
  presynced.outputs.set(Scenario.SyncedRosterKey, full)
  await Assert.rejects(
    Scenario.assertHandoffSyncedRoster(presynced),
    /govc must not have been on sysio\.nodes@active before the handoff/
  )
})

test("an owner registered after the last syncnodes is on the roster but not on sysio.nodes@active", async () => {
  const synced = ["gova", "govb"],
    ctx = contextWith(
      rosterWire(["gova", "govb", "govc"], Steps.governance.supermajorityAuthority(synced))
    )
  ctx.outputs.set(Scenario.SyncedRosterKey, synced)
  await Scenario.assertUnsyncedOwner(ctx, "govc")
  await Assert.rejects(Scenario.assertUnsyncedOwner(ctx, "govd"), /govd must be on the roster/)
})
