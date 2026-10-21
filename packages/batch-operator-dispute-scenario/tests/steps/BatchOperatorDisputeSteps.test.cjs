const Assert = require("node:assert/strict")
const { test } = require("node:test")

const { OutputStore } = require("@wireio/cluster-tool")
const { SysioContracts } = require("@wireio/sdk-core")
const {
  BatchOperatorDisputeConstants: Constants,
  BatchOperatorDisputeSteps: DisputeSteps
} = require("../../lib/index.js")

const ContestedEpoch = 17
const DisputeId = 42
const CanonicalAccount = "wireno.canon"
const CanonicalChecksum = "canonical-checksum"

function epochStateRow(overrides = {}) {
  return {
    current_epoch_index: ContestedEpoch,
    current_epoch_start: "2026-08-28T00:00:00.000",
    next_epoch_start: "2026-08-28T00:01:00.000",
    current_batch_op_group: 0,
    batch_op_groups: [["wireno.a", "wireno.b", "wireno.c"]],
    last_consensus_hash: "",
    is_paused: false,
    ...overrides
  }
}

function operatorStatusContext(status) {
  const outputs = new OutputStore()
  const account = "wireno.observe"
  return {
    outputs,
    keyStore: {
      assertOperator(label) {
        Assert.equal(label, "dispop.b")
        return { account }
      }
    },
    wire: {
      getSysioContract(name) {
        Assert.equal(name, SysioContracts.SysioContractName.opreg)
        return {
          tables: {
            operators: {
              async query() {
                return {
                  rows: [{ account, status }],
                  more: false
                }
              }
            }
          }
        }
      }
    }
  }
}

function disputeRow(candidateCount, overrides = {}) {
  return {
    id: DisputeId,
    chain_code: String(Constants.ContestedChainCode),
    epoch_index: ContestedEpoch,
    status: SysioContracts.SysioChalgDisputestatus.DISPUTE_STATUS_OPEN,
    winning_checksum: "",
    opened_at: "2026-08-28T00:00:00",
    deadline: "2026-08-28T00:01:00",
    candidates: [
      { checksum: CanonicalChecksum, operators: [CanonicalAccount] },
      ...Array.from({ length: candidateCount - 1 }, (_unused, index) => ({
        checksum: `fork-checksum-${index + 1}`,
        operators: [`wireno.fork${index + 1}`]
      }))
    ],
    network_gen: 1,
    electorate: ["voter1", "voter2", "voter3"],
    quorum: 2,
    ...overrides
  }
}

function disputeContext(rows) {
  const outputs = new OutputStore()
  outputs.set(DisputeSteps.ContestedEpochKey, ContestedEpoch)
  return {
    outputs,
    keyStore: {
      assertOperator(label) {
        Assert.equal(label, Constants.CanonicalOperator)
        return { account: CanonicalAccount }
      }
    },
    wire: {
      getSysioContract() {
        return {
          tables: {
            disputes: {
              async query() {
                return { rows, more: false }
              }
            }
          }
        }
      }
    }
  }
}

test("await-dispute-open stores the canonical candidate for a two-way tie", async () => {
  const ctx = disputeContext([disputeRow(2)])

  await DisputeSteps.runAwaitDisputeOpened(
    ctx,
    {
      kind: "BatchOperatorDisputeSteps.AwaitDisputeOpenedInput",
      expectedCandidateCount: 2
    },
    new AbortController().signal
  )

  Assert.deepEqual(ctx.outputs.assert(DisputeSteps.DisputeResolutionKey), {
    disputeId: DisputeId,
    canonicalChecksum: CanonicalChecksum
  })
})

test("await-dispute-open accepts the preserved three-candidate topology", async () => {
  const ctx = disputeContext([disputeRow(3)])

  await DisputeSteps.runAwaitDisputeOpened(
    ctx,
    {
      kind: "BatchOperatorDisputeSteps.AwaitDisputeOpenedInput",
      expectedCandidateCount: 3
    },
    new AbortController().signal
  )

  Assert.deepEqual(ctx.outputs.assert(DisputeSteps.DisputeResolutionKey), {
    disputeId: DisputeId,
    canonicalChecksum: CanonicalChecksum
  })
})

test("await-dispute-open ignores an open dispute for another outpost", async () => {
  const wrongOutpost = disputeRow(2, {
    id: 99,
    chain_code: String(Constants.NonContestedChainCode)
  })
  const ctx = disputeContext([wrongOutpost, disputeRow(2)])

  await DisputeSteps.runAwaitDisputeOpened(
    ctx,
    {
      kind: "BatchOperatorDisputeSteps.AwaitDisputeOpenedInput",
      expectedCandidateCount: 2
    },
    new AbortController().signal
  )

  Assert.deepEqual(ctx.outputs.assert(DisputeSteps.DisputeResolutionKey), {
    disputeId: DisputeId,
    canonicalChecksum: CanonicalChecksum
  })
})

test("await-dispute-open rejects a candidate-count mismatch", async () => {
  const ctx = disputeContext([disputeRow(2)])

  await Assert.rejects(
    DisputeSteps.runAwaitDisputeOpened(
      ctx,
      {
        kind: "BatchOperatorDisputeSteps.AwaitDisputeOpenedInput",
        expectedCandidateCount: 3
      },
      new AbortController().signal
    ),
    /expected exactly 3 dispute candidates, got 2/
  )
  Assert.equal(ctx.outputs.has(DisputeSteps.DisputeResolutionKey), false)
})

test("tagged delivery uses the canonical msgch runner and operator authorization", async () => {
  const outputs = new OutputStore()
  const calls = []
  const account = "wireno.deliver"
  outputs.set(DisputeSteps.ContestedEpochKey, ContestedEpoch)
  const ctx = {
    outputs,
    keyStore: {
      assertOperator(label) {
        Assert.equal(label, "dispop.a")
        return { account }
      }
    },
    wire: {
      getSysioContract(name) {
        Assert.equal(name, SysioContracts.SysioContractName.msgch)
        return {
          tables: {
            outpcons: {
              async query() {
                return { rows: [], more: false }
              }
            }
          },
          actions: {
            deliver: {
              async invoke(...args) {
                calls.push(args)
              }
            }
          }
        }
      }
    }
  }

  await DisputeSteps.runDeliverTaggedEnvelope(
    ctx,
    {
      kind: "BatchOperatorDisputeSteps.DeliverTaggedEnvelopeInput",
      batchOperatorLabel: "dispop.a",
      chainCode: 9_001,
      tag: "canonical"
    },
    new AbortController().signal
  )

  Assert.equal(calls.length, 1)
  Assert.equal(calls[0][0].batch_op_name, account)
  Assert.equal(calls[0][0].chain_code, 9_001)
  Assert.match(calls[0][0].data, /^[0-9a-f]+$/)
  Assert.deepEqual(calls[0][1], {
    authorization: [{ actor: account, permission: "active" }]
  })
})

test("canonical voting uses the stored target and voter authorization", async () => {
  const outputs = new OutputStore()
  const calls = []
  outputs.set(DisputeSteps.DisputeResolutionKey, {
    disputeId: DisputeId,
    canonicalChecksum: CanonicalChecksum
  })
  const ctx = {
    outputs,
    wire: {
      getSysioContract(name) {
        Assert.equal(name, SysioContracts.SysioContractName.chalg)
        return {
          actions: {
            votedispute: {
              async invoke(...args) {
                calls.push(args)
              }
            }
          }
        }
      }
    }
  }

  await DisputeSteps.runVoteCanonicalDispute(
    ctx,
    {
      kind: "BatchOperatorDisputeSteps.VoteCanonicalDisputeInput",
      owner: "voter1"
    },
    new AbortController().signal
  )

  Assert.deepEqual(calls, [
    [
      {
        owner: "voter1",
        dispute_id: DisputeId,
        chosen_checksum: CanonicalChecksum
      },
      { authorization: [{ actor: "voter1", permission: "active" }] }
    ]
  ])
})

test("contested epoch staging waits for the chain boundary and records the epoch", async () => {
  const outputs = new OutputStore()
  const ctx = {
    outputs,
    wire: {
      async getEpochState() {
        return { rows: [epochStateRow()], more: false }
      },
      async getInfo() {
        return { head_block_time: "2026-08-28T00:02:00.000" }
      }
    }
  }

  await DisputeSteps.runStageContestedEpoch(
    ctx,
    null,
    new AbortController().signal
  )

  Assert.equal(
    ctx.outputs.assert(DisputeSteps.ContestedEpochKey),
    ContestedEpoch
  )
})

test("settlement requires a stable dispute-owned epoch", async () => {
  const originalInterval = Constants.settlePollIntervalMs
  Constants.settlePollIntervalMs = () => 0
  try {
    const accounts = ["wireno.a", "wireno.b", "wireno.c"]
    let reads = 0
    const ctx = {
      keyStore: {
        assertOperator(label) {
          const index = Constants.DisputeOperators.indexOf(label)
          Assert.notEqual(index, -1)
          return { account: accounts[index] }
        }
      },
      wire: {
        async getEpochState() {
          reads += 1
          return {
            rows: [epochStateRow({ batch_op_groups: [accounts] })],
            more: false
          }
        }
      }
    }

    Assert.equal(await DisputeSteps.settleOnDisputeEpoch(ctx), ContestedEpoch)
    Assert.ok(reads >= Constants.SettleStableChecks + 2)
  } finally {
    Constants.settlePollIntervalMs = originalInterval
  }
})

test("resolution accepts only the stored canonical winner", async () => {
  const resolved = disputeRow(2, {
    status: SysioContracts.SysioChalgDisputestatus.DISPUTE_STATUS_RESOLVED,
    winning_checksum: CanonicalChecksum
  })
  const ctx = disputeContext([resolved])
  ctx.outputs.set(DisputeSteps.DisputeResolutionKey, {
    disputeId: DisputeId,
    canonicalChecksum: CanonicalChecksum
  })

  await DisputeSteps.runAwaitDisputeResolved(
    ctx,
    null,
    new AbortController().signal
  )
})

test("operator observers accept the expected SLASHED and ACTIVE states", async () => {
  await DisputeSteps.runAwaitOperatorSlashed(
    operatorStatusContext(
      SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_SLASHED
    ),
    {
      kind: "BatchOperatorDisputeSteps.AwaitOperatorSlashedInput",
      label: "dispop.b"
    },
    new AbortController().signal
  )

  await DisputeSteps.runAwaitOperatorActive(
    operatorStatusContext(
      SysioContracts.SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
    ),
    {
      kind: "BatchOperatorDisputeSteps.AwaitOperatorActiveInput",
      label: "dispop.b"
    },
    new AbortController().signal
  )
})

test("await-dispute-open performs no work when pre-aborted", async () => {
  const ctx = disputeContext([disputeRow(2)])
  const controller = new AbortController()
  controller.abort()

  await Assert.rejects(
    DisputeSteps.runAwaitDisputeOpened(
      ctx,
      {
        kind: "BatchOperatorDisputeSteps.AwaitDisputeOpenedInput",
        expectedCandidateCount: 2
      },
      controller.signal
    ),
    { name: "AbortError" }
  )
  Assert.equal(ctx.outputs.has(DisputeSteps.DisputeResolutionKey), false)

  const stageOutputs = new OutputStore()
  await Assert.rejects(
    DisputeSteps.runStageContestedEpoch(
      { outputs: stageOutputs },
      null,
      controller.signal
    ),
    { name: "AbortError" }
  )
  Assert.equal(stageOutputs.has(DisputeSteps.ContestedEpochKey), false)
})

test("candidate lookup returns only the checksum delivered by the requested operator", () => {
  const candidates = disputeRow(2).candidates
  Assert.equal(
    DisputeSteps.candidateChecksumForOperator(candidates, CanonicalAccount),
    CanonicalChecksum
  )
  Assert.equal(
    DisputeSteps.candidateChecksumForOperator(candidates, "wireno.missing"),
    undefined
  )
})
