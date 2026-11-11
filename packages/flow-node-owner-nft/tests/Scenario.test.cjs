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
  NodeOwnerNftScenarioConstants: Constants
} = require("../lib/NodeOwnerNftScenarioConstants.js")
const {
  NodeOwnerNftScenarioRegistrationSteps: RegistrationSteps
} = require("../lib/steps/NodeOwnerNftScenarioRegistrationSteps.js")

afterEach(() => mock.restoreAll())

function planPhases() {
  const build = ClusterBuild.forContext({ outputs: new OutputStore() })
  new NodeOwnerNftScenario().plan(build)
  return build.children
}

const createKind = "NodeOwnerNftScenarioRegistrationSteps.CreateNamedUserInput",
  walletKind = "EthereumFundingTool.CreateWalletInput",
  linkKind = "SyndicationUserSteps.LinkEthereumKeyInput",
  registerKind = "NodeOwnerNftScenarioRegistrationSteps.RegisterNodeOwnerInput"

test("only the rejection fixtures create accounts before registration", () => {
  const phases = planPhases(),
    fixtures = phases.filter(phase =>
      phase.steps.some(step => step.input?.kind === createKind)
    )
  Assert.equal(NodeOwnerRejectReason.AccountExists, 7)
  Assert.deepEqual(
    fixtures.map(phase => phase.name),
    ["WrongKey", "ExistingAccount"]
  )
  for (const phase of fixtures) {
    const [create, linkedWallet, link, claimWallet, register] = phase.steps
    Assert.deepEqual(
      [create, linkedWallet, link, claimWallet, register].map(
        step => step.input.kind
      ),
      [createKind, walletKind, linkKind, walletKind, registerKind]
    )
    Assert.equal(link.input.account, create.input.account)
    Assert.equal(register.input.ownerAccount, create.input.account)
    Assert.equal(linkedWallet.input.walletName, link.input.walletName)
    Assert.equal(claimWallet.input.walletName, register.input.walletName)
    Assert.notEqual(link.input.walletName, register.input.walletName)
  }
})

test("every claim's depositor wallet is persisted in its phase before the claim, under its own handle", () => {
  const phases = planPhases(),
    walletNames = phases.flatMap(phase =>
      phase.steps
        .filter(step => step.input?.kind === walletKind)
        .map(step => step.input.walletName)
    ),
    claims = phases.flatMap(phase =>
      phase.steps
        .map((step, index) => ({ phase, step, earlier: phase.steps.slice(0, index) }))
        .filter(({ step }) => step.input?.kind === registerKind)
    )
  Assert.ok(claims.length > 0)
  Assert.equal(new Set(walletNames).size, walletNames.length)
  for (const { phase, step, earlier } of claims) {
    Assert.ok(
      earlier.some(
        previous =>
          previous.input?.kind === walletKind &&
          previous.input.walletName === step.input.walletName
      ),
      `${phase.name}: ${step.input.ownerAccount} claims with a wallet no earlier step persisted`
    )
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
  const linkedWalletNames = new Set([
    Constants.WrongKeyLinkedWalletName,
    Constants.ExistingLinkedWalletName,
    Constants.DuplicateWalletName
  ])
  mock.method(
    RegistrationSteps,
    "loadDepositorPublicKey",
    (_ctx, walletName) =>
      (linkedWalletNames.has(walletName) ? originalKey : rejectedKey).compressed
  )
  const phases = planPhases()
  for (const name of ["WrongKey", "ExistingAccount", "Duplicate"]) {
    const { steps } = phases.find(phase => phase.name === name),
      register = steps.find(step => step.input?.kind === registerKind),
      duplicate = name === "Duplicate",
      account = register.input.ownerAccount,
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
