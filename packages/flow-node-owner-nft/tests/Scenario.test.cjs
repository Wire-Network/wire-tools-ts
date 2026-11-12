const Assert = require("node:assert/strict")
const { afterEach, mock, test } = require("node:test")

const { SysioContracts } = require("@wireio/sdk-core")
const {
  ClusterBuild,
  NodeOwnerRegStatus,
  NodeOwnerRejectReason,
  NodeOwnerTier,
  OutputStore,
  Steps
} = require("@wireio/cluster-tool")

const { NodeOwnerNftScenario } = require("../lib/NodeOwnerNftScenario.js")
const {
  NodeOwnerNftScenarioConstants: Constants
} = require("../lib/NodeOwnerNftScenarioConstants.js")
const { registration: RegistrationSteps } = Steps.nodeOwner

afterEach(() => mock.restoreAll())

function planPhases() {
  const build = ClusterBuild.forContext({ outputs: new OutputStore() })
  new NodeOwnerNftScenario().plan(build)
  return build.children
}

test("only the rejection fixtures create accounts before registration", () => {
  const phases = planPhases(),
    createKind = "NodeOwnerRegistrationSteps.CreateNamedUserInput",
    linkKind = "NodeOwnerRegistrationSteps.AuthexLinkInput",
    registerKind = "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput",
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

// Two valid points with the same X coordinate and opposite Y parity.
const keyX = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  originalKey = {
    compressed: `PUB_EM_02${keyX}`,
    uncompressed: `PUB_EM_04${keyX}483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8`
  },
  rejectedKey = {
    compressed: `PUB_EM_03${keyX}`,
    uncompressed: `PUB_EM_04${keyX}b7c52588d95c3b9aa25b0403f1eef75702e84bb7597aabe663b82f6f04ef2777`
  }

async function checkRejectionState(readbackEncoding) {
  const linkedIndices = new Set([
    Constants.WrongKeyLinkedEthereumHdIndex,
    Constants.ExistingLinkedEthereumHdIndex,
    Constants.DuplicateEthereumHdIndex
  ])
  mock.method(
    RegistrationSteps,
    "newEthereumPublicKey",
    async (_ctx, index) =>
      (linkedIndices.has(index) ? originalKey : rejectedKey).compressed
  )
  const phases = planPhases()
  for (const name of ["WrongKey", "ExistingAccount", "Duplicate"]) {
    const { steps } = phases.find(phase => phase.name === name),
      [first] = steps,
      duplicate = name === "Duplicate",
      account = duplicate ? first.input.ownerAccount : first.input.account,
      verify = steps.at(-1),
      linked = {
        username: account,
        chain_kind: SysioContracts.SysioAuthexChainkind.CHAIN_KIND_EVM,
        pub_key: originalKey[readbackEncoding]
      },
      rejectedLink = rejectedKey[readbackEncoding],
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
            roastate: { query: async () => ({ rows: [{ network_gen: 0 }] }) },
            nodeowners: { queryAll: async () => owners },
            nodeownerreg: { queryAll: async () => [audit] }
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
      verifyState([{ ...linked, pub_key: rejectedLink }]),
      /original Ethereum link/
    )
    await Assert.rejects(
      verifyState([
        linked,
        { ...linked, username: "other", pub_key: rejectedLink }
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
}

test("rejection checks fail if an Ethereum link or original tier changes", () =>
  checkRejectionState("compressed"))

test("uncompressed AuthEx rows match compressed fixture keys and expose rejected links", () =>
  checkRejectionState("uncompressed"))
