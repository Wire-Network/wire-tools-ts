const Assert = require("node:assert/strict")
const { afterEach, mock, test } = require("node:test")

const { SysioContracts } = require("@wireio/sdk-core")
const {
  ClusterBuild,
  NodeOwnerRegStatus,
  NodeOwnerRejectReason,
  NodeOwnerTier,
  OutputStore
} = require("@wireio/cluster-tool")

const { NodeOwnerNftScenario } = require("../lib/NodeOwnerNftScenario.js")
const {
  NodeOwnerNftScenarioRegistrationSteps: RegistrationSteps
} = require("../lib/steps/NodeOwnerNftScenarioRegistrationSteps.js")

afterEach(() => mock.restoreAll())

function planPhases() {
  const build = ClusterBuild.forContext({ outputs: new OutputStore() })
  new NodeOwnerNftScenario().plan(build)
  return build.children
}

test("only the rejection fixtures create accounts before registration", () => {
  const phases = planPhases(),
    createKind = "NodeOwnerNftScenarioRegistrationSteps.CreateNamedUserInput",
    linkKind = "NodeOwnerNftScenarioRegistrationSteps.AuthexLinkInput",
    registerKind =
      "NodeOwnerNftScenarioRegistrationSteps.RegisterNodeOwnerInput",
    fixtures = phases.filter(phase =>
      phase.steps.some(step => step.input?.kind === createKind)
    )
  Assert.equal(NodeOwnerRejectReason.AccountExists, 7)
  Assert.deepEqual(
    fixtures.map(phase => phase.name),
    ["WrongKey", "ExistingAccount"]
  )
  for (const phase of fixtures) {
    const [create, link, register] = phase.steps
    Assert.deepEqual(
      [create.input.kind, link.input.kind, register.input.kind],
      [createKind, linkKind, registerKind]
    )
    Assert.equal(link.input.account, create.input.account)
    Assert.equal(register.input.ownerAccount, create.input.account)
    Assert.notEqual(link.input.ethereumHdIndex, register.input.ethereumHdIndex)
  }
})

test("rejection checks fail if an Ethereum link or original tier changes", async () => {
  mock.method(
    RegistrationSteps,
    "newEthereumPublicKey",
    async (_ctx, index) => `key-${index}`
  )
  const phases = planPhases()
  for (const name of ["WrongKey", "ExistingAccount", "Duplicate"]) {
    const { steps } = phases.find(phase => phase.name === name),
      [first, second, third] = steps,
      duplicate = name === "Duplicate",
      account = duplicate ? first.input.ownerAccount : first.input.account,
      original = duplicate ? first : second,
      rejected = duplicate ? second : third,
      verify = steps.at(-1),
      linked = {
        username: account,
        chain_kind: SysioContracts.SysioAuthexChainkind.CHAIN_KIND_EVM,
        pub_key: `key-${original.input.ethereumHdIndex}`
      },
      rejectedKey = `key-${rejected.input.ethereumHdIndex}`,
      members = duplicate ? [{ owner: account, tier: NodeOwnerTier.T1 }] : [],
      audit = {
        owner: account,
        status: NodeOwnerRegStatus.Rejected,
        reason: duplicate
          ? NodeOwnerRejectReason.Duplicate
          : NodeOwnerRejectReason.AccountExists
      }
    const verifyState = (links, owners = members) => {
      const contracts = {
        [SysioContracts.SysioContractName.roa]: {
          tables: {
            nodeowners: { query: async () => ({ rows: owners }) },
            nodeownerreg: { query: async () => ({ rows: [audit] }) }
          }
        },
        [SysioContracts.SysioContractName.authex]: {
          tables: { links: { queryAll: async () => links } }
        }
      }
      const ctx = { wire: { getSysioContract: name => contracts[name] } }
      return verify.runner(ctx, verify.input, new AbortController().signal)
    }
    await verifyState([linked])
    await Assert.rejects(
      verifyState([{ ...linked, pub_key: rejectedKey }]),
      /original Ethereum link/
    )
    await Assert.rejects(
      verifyState([
        linked,
        { ...linked, username: "other", pub_key: rejectedKey }
      ]),
      /rejected depositor key/
    )
    if (duplicate) {
      await Assert.rejects(
        verifyState([linked], [{ owner: account, tier: NodeOwnerTier.T2 }]),
        /original Tier-1 membership/
      )
    } else {
      await Assert.rejects(
        verifyState([linked], [{ owner: account, tier: NodeOwnerTier.T1 }]),
        /nodeowners row must be absent/
      )
    }
  }
})
