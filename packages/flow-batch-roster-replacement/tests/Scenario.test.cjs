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
