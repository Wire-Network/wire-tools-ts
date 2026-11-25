const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  EthereumSyndicationTool,
  SolanaOutpostProgramTool
} = require("@wireio/cluster-tool")
const { PrivateKey, KeyType } = require("@wireio/sdk-core")
const {
  BatchRosterReplacementScenario: Scenario
} = require("../lib/BatchRosterReplacementScenario.js")
afterEach(() => mock.restoreAll())
test("Ethereum signer normalization preserves the replacement identity", () => {
  for (const address of [
    "1234567890123456789012345678901234567890",
    "0x1234567890123456789012345678901234567890"
  ])
    Assert.equal(
      Scenario.ethereumAddress({
        keyStore: { assertOperator: () => ({ ethereum: { address } }) }
      }),
      "0x1234567890123456789012345678901234567890"
    )
})
test("Solana signing address derives from the same persisted replacement public key", () => {
  const key = PrivateKey.generate(KeyType.ED),
    ctx = {
      keyStore: {
        assertOperator: () => ({
          solana: { publicKey: key.toPublic().toString() }
        })
      }
    }
  Assert.deepEqual(
    Buffer.from(Scenario.solanaAddress(ctx).toBytes()),
    Buffer.from(key.toPublic().data.array)
  )
})
test("missing registry cannot pass consumer verification", async () => {
  const id = Scenario.solanaAddress({
    keyStore: {
      assertOperator: () => ({
        solana: {
          publicKey: PrivateKey.generate(KeyType.ED).toPublic().toString()
        }
      })
    }
  })
  mock.method(SolanaOutpostProgramTool, "loadReadOnlyProgram", () => ({
    programId: id
  }))
  const ctx = {
    config: { solanaPath: "/tmp/no-artifact" },
    solana: { connection: { getAccountInfo: async () => null } }
  }
  await Assert.rejects(Scenario.solanaRegistry(ctx), /registry missing/)
})

test("only the canonical accepted Ethereum digest proves replacement delivery", () => {
  const digest = "0x" + "ab".repeat(32),
    other = "0x" + "cd".repeat(32),
    zero = "0x" + "00".repeat(32)
  Assert.equal(
    Scenario.isAcceptedEthereumDelivery(4, digest, {
      epochIndex: 4n,
      checksum: digest
    }),
    true
  )
  Assert.equal(
    Scenario.isAcceptedEthereumDelivery(4, other, {
      epochIndex: 4n,
      checksum: digest
    }),
    false
  )
  Assert.equal(
    Scenario.isAcceptedEthereumDelivery(4, digest, {
      epochIndex: 3n,
      checksum: digest
    }),
    false
  )
  Assert.equal(
    Scenario.isAcceptedEthereumDelivery(4, zero, {
      epochIndex: 4n,
      checksum: zero
    }),
    false
  )
})
test("stale entries, missing groups and inactive replacement cannot pass the SOL consumer check", () => {
  const {
    OperatorType,
    OperatorStatus
  } = require("@wireio/opp-typescript-models")
  const address = Scenario.solanaAddress({
    keyStore: {
      assertOperator: () => ({
        solana: {
          publicKey: PrivateKey.generate(KeyType.ED).toPublic().toString()
        }
      })
    }
  })
  const entry = {
      solAddress: address,
      role: OperatorType.BATCH,
      status: OperatorStatus.ACTIVE
    },
    group = { memberCount: 1, members: [address] }
  const registry = {
    operatorCount: 1,
    groupCount: 1,
    operators: [entry],
    groups: [group]
  }
  Assert.equal(Scenario.isInstalledSolanaReplacement(registry, address), true)
  Assert.equal(
    Scenario.isInstalledSolanaReplacement(
      { ...registry, operatorCount: 0 },
      address
    ),
    false
  )
  Assert.equal(
    Scenario.isInstalledSolanaReplacement(
      { ...registry, groupCount: 0 },
      address
    ),
    false
  )
  Assert.equal(
    Scenario.isInstalledSolanaReplacement(
      {
        ...registry,
        operators: [{ ...entry, status: OperatorStatus.UNKNOWN }]
      },
      address
    ),
    false
  )
})
test("chunk staging, stale retries and minority SOL votes cannot prove accepted delivery", () => {
  const key = () =>
    Scenario.solanaAddress({
      keyStore: {
        assertOperator: () => ({
          solana: {
            publicKey: PrivateKey.generate(KeyType.ED).toPublic().toString()
          }
        })
      }
    })
  const signer = key(),
    other = key(),
    checksum = Array(32).fill(7),
    wrong = Array(32).fill(8),
    accepted = { epochIndex: 4, checksum },
    votes = {
      epochIndex: 4,
      consensusReached: true,
      consensusHash: checksum,
      deliveries: [{ operator: signer, envelopeHash: checksum }]
    }
  Assert.equal(Scenario.isAcceptedSolanaDelivery(votes, accepted, signer), true)
  Assert.equal(
    Scenario.isAcceptedSolanaDelivery(
      { ...votes, deliveries: [] },
      accepted,
      signer
    ),
    false
  )
  Assert.equal(
    Scenario.isAcceptedSolanaDelivery(
      { ...votes, consensusReached: false },
      accepted,
      signer
    ),
    false
  )
  Assert.equal(
    Scenario.isAcceptedSolanaDelivery(
      { ...votes, epochIndex: 3 },
      accepted,
      signer
    ),
    false
  )
  Assert.equal(
    Scenario.isAcceptedSolanaDelivery(
      { ...votes, consensusHash: wrong },
      accepted,
      signer
    ),
    false
  )
  Assert.equal(
    Scenario.isAcceptedSolanaDelivery(
      { ...votes, deliveries: [{ operator: signer, envelopeHash: wrong }] },
      accepted,
      signer
    ),
    false
  )
  Assert.equal(Scenario.isAcceptedSolanaDelivery(votes, accepted, other), false)
})
for (const exists of [true, false])
  test(`SOL destination cursor read uses deployed program decoder: ${exists}`, async () => {
    const key = PrivateKey.generate(KeyType.ED),
      id = Scenario.solanaAddress({
        keyStore: {
          assertOperator: () => ({
            solana: { publicKey: key.toPublic().toString() }
          })
        }
      })
    mock.method(SolanaOutpostProgramTool, "loadReadOnlyProgram", () => ({
      programId: id,
      coder: {
        accounts: {
          decode: (name, data) => {
            Assert.equal(name, "outpostConfig")
            Assert.deepEqual(data, Buffer.from([9]))
            return { nextEpochIndex: 7 }
          }
        }
      }
    }))
    const ctx = {
      config: { solanaPath: "/tmp/deployed-idl" },
      solana: {
        connection: {
          getAccountInfo: async () =>
            exists ? { data: Buffer.from([9]) } : null
        }
      }
    }
    if (exists)
      Assert.equal((await Scenario.solanaConfig(ctx)).nextEpochIndex, 7)
    else await Assert.rejects(Scenario.solanaConfig(ctx), /config missing/)
  })

test("replacement topology resolves and reuses its registered daemon port pair", async () => {
  const { BindConfigProvider } = require("@wireio/cluster-tool")
  const scenario = new Scenario(),
    bind = await BindConfigProvider.resolve({}, scenario.defaults)
  const pair = BindConfigProvider.claimAdHocPorts(bind, Scenario.Label)
  Assert.deepEqual(pair, bind.nodeop.ports.adHoc[0])
  Assert.ok(BindConfigProvider.allPorts(bind).includes(pair.http))
  Assert.ok(BindConfigProvider.allPorts(bind).includes(pair.p2p))
  Assert.deepEqual(
    BindConfigProvider.claimAdHocPorts(bind, Scenario.Label),
    pair
  )
  Assert.throws(
    () => BindConfigProvider.claimAdHocPorts(bind, "unexpected-second-node"),
    /ad-hoc port pool exhausted/
  )
})

test("replacement provisioning funds its real Solana signer and preserves roster lookahead", () => {
  const {
    ClusterBuild,
    OutputStore,
    DefaultBatchOperatorGroupCount,
    WireOperatorProvisioningTool
  } = require("@wireio/cluster-tool")
  const scenario = new Scenario(),
    build = ClusterBuild.forContext({
      outputs: new OutputStore(),
      config: {
        batchOperatorCount: scenario.defaults.batchOperatorCount,
        underwriterCount: 0,
        producerCount: 1
      }
    })
  scenario.plan(build)
  const flatten = node =>
      node.steps ? [...node.steps] : node.children.flatMap(flatten),
    steps = flatten(build)
  const funding = steps.find(
    step =>
      step.input?.kind === "WireOperatorProvisioningTool.AirdropSolanaInput"
  )
  Assert.ok(funding, "replacement must get actual SOL fee and rent funding")
  Assert.equal(funding.input.label, Scenario.Label)
  Assert.equal(
    funding.input.lamports,
    WireOperatorProvisioningTool.DefaultSolanaAirdropLamports
  )
  Assert.equal(scenario.defaults.batchOpGroups, DefaultBatchOperatorGroupCount)
  Assert.equal(
    scenario.defaults.batchOperatorCount,
    DefaultBatchOperatorGroupCount
  )
  Assert.ok(
    scenario.defaults.batchOpGroups > 1,
    "single-group current==next fallback cannot admit new membership safely"
  )
})

/** The planned scenario's step named `name`. */
function plannedStep(name) {
  const { ClusterBuild, OutputStore } = require("@wireio/cluster-tool"),
    scenario = new Scenario(),
    build = ClusterBuild.forContext({
      outputs: new OutputStore(),
      config: { batchOperatorCount: scenario.defaults.batchOperatorCount, underwriterCount: 0, producerCount: 1 }
    })
  scenario.plan(build)
  const flatten = node => (node.steps ? [...node.steps] : node.children.flatMap(flatten))
  return flatten(build).find(step => step.name === name)
}

/** Every chain idle, so the keep-due pump gives traffic to each chain a wait names. */
function idleChains() {
  const { Steps, Constants } = require("@wireio/cluster-tool"),
    idle = { current_epoch_index: 4, due_at: "1970-01-01T00:00:00.000", is_paused: false }
  mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => ({
    [Constants.ETHEREUM_CHAIN_CODENAME]: idle,
    [Constants.SOLANA_CHAIN_CODENAME]: idle
  }))
  return mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
}

test("the Ethereum delivery check keeps Ethereum due until an epoch carries the replacement's accepted delivery", async () => {
  const { OutputStore, Constants } = require("@wireio/cluster-tool"),
    StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js"),
    step = plannedStep("replacement-relayed-ethereum"),
    ctx = {
      outputs: new OutputStore().set(Scenario.EthereumEpochBefore, 7),
      keyStore: { assertOperator: () => ({ ethereum: { address: "0x1234567890123456789012345678901234567890" } }) }
    },
    push = idleChains()
  // Ethereum has not advanced past the recorded epoch: no epoch to inspect yet.
  mock.method(Scenario, "inbound", () => ({ nextEpochIndex: async () => 7n }))
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), `Timed out waiting for: ${label}`)
  })
  await Assert.rejects(step.runner(ctx, step.input, new AbortController().signal), /replacement accepted on Ethereum/)
  Assert.deepEqual(push.mock.calls.map(call => call.arguments[1].data.chain_code), [Constants.ETHEREUM_CHAIN_CODENAME])
})

test("the Solana delivery check keeps Solana alone due while no post-roster epoch carries the replacement's vote", async () => {
  const { OutputStore, Constants } = require("@wireio/cluster-tool"),
    StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js"),
    step = plannedStep("replacement-relayed-solana"),
    ctx = { outputs: new OutputStore().set(Scenario.SolanaEpochBefore, 3) },
    push = idleChains()
  mock.method(Scenario, "solanaConfig", async () => ({ nextEpochIndex: 3 }))
  mock.method(Scenario, "solanaInbound", async () => ({ envelopes: [] }))
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), `Timed out waiting for: ${label}`)
  })
  await Assert.rejects(step.runner(ctx, step.input, new AbortController().signal), /replacement accepted on Solana/)
  Assert.deepEqual(push.mock.calls.map(call => call.arguments[1].data.chain_code), [Constants.SOLANA_CHAIN_CODENAME])
})

test("the inherited Ethereum intake wait keeps Ethereum alone due until the held envelope appears", async () => {
  const { OutputStore, Constants, EthereumRoundTripScenario, EthereumFundingTool, WireSyndicationTool } = require("@wireio/cluster-tool"),
    StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js"),
    step = plannedStep("ethereum-intake-held"),
    push = idleChains()
  Assert.equal(EthereumRoundTripScenario.Chain, Constants.ETHEREUM_CHAIN_CODENAME)
  mock.method(EthereumFundingTool, "compressedPubkey", () => "0x02" + "11".repeat(32))
  mock.method(WireSyndicationTool, "readHeldEnvelope", async () => undefined)
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), `Timed out waiting for: ${label}`)
  })
  await Assert.rejects(
    step.runner({ outputs: new OutputStore() }, step.input, new AbortController().signal),
    /Ethereum syndication intake/
  )
  Assert.deepEqual(push.mock.calls.map(call => call.arguments[1].data.chain_code), [Constants.ETHEREUM_CHAIN_CODENAME])
})

test("the inherited post-settlement wait keeps Ethereum due for one more accepted inbound epoch", async () => {
  const { OutputStore, Constants, EthereumRoundTripScenario } = require("@wireio/cluster-tool"),
    StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js"),
    step = plannedStep("settlement-stays-exact"),
    push = idleChains()
  mock.method(EthereumRoundTripScenario, "readInboundEpoch", async () => 12)
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), `Timed out waiting for: ${label}`)
  })
  await Assert.rejects(
    step.runner(
      { outputs: new OutputStore().set(EthereumRoundTripScenario.SettledEpoch, 12) },
      step.input,
      new AbortController().signal
    ),
    /post-settlement Ethereum inbound progress/
  )
  Assert.deepEqual(push.mock.calls.map(call => call.arguments[1].data.chain_code), [Constants.ETHEREUM_CHAIN_CODENAME])
})

/** A `rostersent` row of each chain named in `hashes` (a chain left out has none). */
function rostersSent(hashes) {
  const { Constants } = require("@wireio/cluster-tool")
  return Object.fromEntries(
    [Constants.ETHEREUM_CHAIN_CODENAME, Constants.SOLANA_CHAIN_CODENAME].map(chain => [
      chain,
      hashes[chain] == null ? undefined : { chain_code: 0, roster_hash: hashes[chain] }
    ])
  )
}

test("the roster checks run over both real outposts, Ethereum first", () => {
  const { Constants } = require("@wireio/cluster-tool")
  Assert.deepEqual(Scenario.OutpostChains, [Constants.ETHEREUM_CHAIN_CODENAME, Constants.SOLANA_CHAIN_CODENAME])
})

test("rosterHashes reads each chain's last-queued roster hash, absent without a row", () => {
  Assert.deepEqual(Scenario.rosterHashes(rostersSent({ ETHEREUM: "aa", SOLANA: "bb" })), { ETHEREUM: "aa", SOLANA: "bb" })
  Assert.deepEqual(Scenario.rosterHashes(rostersSent({ ETHEREUM: "aa" })), { ETHEREUM: "aa", SOLANA: undefined })
})

test("a rostersent row erased mid-wait fails: a resent roster would mask the depot's own diff", () => {
  Scenario.assertRosterSentKept(rostersSent({ ETHEREUM: "aa", SOLANA: "bb" }))
  Assert.throws(
    () => Scenario.assertRosterSentKept(rostersSent({ ETHEREUM: "aa" })),
    /rostersent lost its SOLANA row: the roster was resent rather than queued by its diff/
  )
})

test("the depot re-queued the roster by itself only when every chain's hash changed and no row is missing", () => {
  const before = { ETHEREUM: "aa", SOLANA: "bb" }
  Scenario.assertRostersRequeued(before, rostersSent({ ETHEREUM: "a2", SOLANA: "b2" }))
  Assert.throws(
    () => Scenario.assertRostersRequeued(before, rostersSent({ ETHEREUM: "a2", SOLANA: "bb" })),
    /never queued a changed roster to the SOLANA outpost: rostersent still holds bb/
  )
  Assert.throws(() => Scenario.assertRostersRequeued(before, rostersSent({ SOLANA: "b2" })), /lost its ETHEREUM row/)
  // A chain no roster had been queued to before counts as changed once one is.
  Scenario.assertRostersRequeued({ ETHEREUM: "aa" }, rostersSent({ ETHEREUM: "a2", SOLANA: "b1" }))
})

test("the admission first records each outpost's last-queued roster hash", async () => {
  const { OutputStore, Steps } = require("@wireio/cluster-tool"),
    step = plannedStep("record-roster-sent"),
    ctx = { outputs: new OutputStore() }
  mock.method(Steps.contracts.sysio.epoch, "readRostersSent", async () => rostersSent({ ETHEREUM: "aa", SOLANA: "bb" }))
  await step.runner(ctx, step.input, new AbortController().signal)
  Assert.deepEqual(ctx.outputs.assert(Scenario.RosterHashesBefore), { ETHEREUM: "aa", SOLANA: "bb" })
})

test("the consumption wait fails at once when a rostersent row disappears, before reading either outpost", async () => {
  const { OutputStore, Steps } = require("@wireio/cluster-tool"),
    StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js"),
    step = plannedStep("both-outposts-consumed-replacement"),
    ctx = { outputs: new OutputStore().set(Scenario.RosterHashesBefore, { ETHEREUM: "aa", SOLANA: "bb" }) },
    push = idleChains(),
    inbound = mock.method(Scenario, "inbound", () => Assert.fail("the outposts must not be read"))
  mock.method(Steps.contracts.sysio.epoch, "readRostersSent", async () => rostersSent({ SOLANA: "bb" }))
  mock.method(StepTools, "pollUntil", async (_label, predicate) => {
    await predicate()
  })
  await Assert.rejects(step.runner(ctx, step.input, new AbortController().signal), /lost its ETHEREUM row/)
  Assert.equal(inbound.mock.callCount(), 0)
  Assert.equal(push.mock.callCount(), 0)
})

test("the consumption check fails when the outposts consumed the replacement but the depot never re-queued a roster", async () => {
  const { OutputStore, Steps } = require("@wireio/cluster-tool"),
    StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js"),
    step = plannedStep("both-outposts-consumed-replacement"),
    ctx = { outputs: new OutputStore().set(Scenario.RosterHashesBefore, { ETHEREUM: "aa", SOLANA: "bb" }) }
  idleChains()
  mock.method(Steps.contracts.sysio.epoch, "readRostersSent", async () => rostersSent({ ETHEREUM: "aa", SOLANA: "b2" }))
  // The wait itself is satisfied; only the roster diff decides.
  mock.method(StepTools, "pollUntil", async () => undefined)
  await Assert.rejects(
    step.runner(ctx, step.input, new AbortController().signal),
    /never queued a changed roster to the ETHEREUM outpost/
  )
})
