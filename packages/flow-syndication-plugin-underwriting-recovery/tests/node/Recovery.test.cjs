const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { Keypair, PublicKey } = require("@solana/web3.js")
const { SlugName, SysioContracts } = require("@wireio/sdk-core")
const {
  BatchOperatorUnderwritingSteps: Underwriting,
  BatchOperatorSchedule,
  ClusterBuild,
  NodeConfig,
  NodeRole,
  OutputStore,
  ProtocolTiming,
  SolanaClient,
  SolanaOutpostProgramTool,
  SolanaOutpostTarget,
  StepExtraRecorder,
  SyndicationScenario,
  WireSyndicationTool
} = require("@wireio/cluster-tool")
const { SyndicationPluginUnderwritingRecoverySteps: Recovery } = require("../../lib/steps/index.js")
const { SyndicationPluginUnderwritingRecoveryScenario: Scenario } = require("../../lib/SyndicationPluginUnderwritingRecoveryScenario.js")
const { SyndicationPluginUnderwritingRecoveryScenarioConstants: Constants } = require("../../lib/SyndicationPluginUnderwritingRecoveryScenarioConstants.js")
const { OriginalEnvelope, PrunedCheckpoint, PrunedSourceLog } = require("../../lib/orchestration/index.js")

afterEach(() => {
  mock.restoreAll()
  mock.timers.reset()
})

const digest = byte => Buffer.alloc(32, byte).toString("hex"),
  original = { chain_code: "SOLANA", token_code: "LIQSOL", epoch_index: 10, digest: digest(1), request_id: "7" },
  checkpoint = { chain_code: String(SlugName.from("SOLANA")), epoch_index: 20,
    consensus_reached: true, envelope_digest: digest(2) },
  record = (epoch, byte = 2) => ({ epochIndex: epoch, checksum: [...Buffer.alloc(32, byte)] }),
  prunedLog = () => ({ bump: 1, envelopes: Array.from({ length: 10 }, (_, index) => record(index + 11)) }),
  openRequest = () => ({ state: SysioContracts.SysioBondRequestState.OPEN, bonded: "0", covered: "2010000000" }),
  nodes = () => Array.from({ length: Constants.BatchOperatorCount }, (_, index) => ({
    role: NodeRole.batch_operator, name: `relay-${index}`, batchOperatorLabel: `operator-${index}`
  }))

/** All account reads are deterministic; no test allocates or dials a port. */
function fixture() {
  const holder = { log: { bump: 1, envelopes: [record(10, 1)] }, original: { ...original },
      request: openRequest(), bonds: [], checkpoint: { ...checkpoint }, running: null },
    ctx = { outputs: new OutputStore(),
      config: { epochDurationSec: Constants.EpochDurationSec,
        batchOperatorUnderwriting: { fundedOperatorCount: 1 } },
      processManager: { get: () => holder.running },
      keyStore: { assertOperator: () => ({ account: "provider" }) },
      wire: { getSysioContract: () => ({ tables: { outpcons: {
        query: async () => ({ rows: [holder.checkpoint], more: false })
      } } }) } },
    programId = Keypair.generate().publicKey,
    connection = { getAccountInfo: async () => ({ owner: programId, data: Buffer.of(1) }) }
  ctx.outputs.set(Constants.Plan.firstEpoch, original.epoch_index)
  ctx.outputs.set(Constants.Plan.firstRequest, original.request_id)
  mock.method(NodeConfig, "plan", nodes)
  mock.method(Underwriting, "fundedOperatorAccounts", () => ["provider"])
  mock.method(Underwriting, "assertUnfundedHoldNothing", async () => {})
  mock.method(SyndicationScenario, "readBalance", async () => 0n)
  mock.method(SyndicationScenario, "readEnvelope", async () => holder.original)
  mock.method(WireSyndicationTool, "readRequest", async () => holder.request)
  mock.method(WireSyndicationTool, "readBonds", async () => holder.bonds)
  mock.method(SolanaOutpostTarget, "fromContext", () => ({ connection, programId, solanaPath: "/unused" }))
  mock.method(SolanaOutpostProgramTool, "loadReadOnlyProgram", () => ({ coder: { accounts: {
    decode: name => { Assert.equal(name, Constants.EnvelopeLogAccountName); return holder.log }
  } } }))
  return { ctx, holder, connection, programId }
}

test("pruned history authenticates only a newer accepted Solana checkpoint", () => {
  Assert.equal(Recovery.hasPrunedCheckpoint(prunedLog(), original, checkpoint), true)
  Assert.equal(Constants.pruningBudgetMs(60), 13 * ProtocolTiming.effectiveEpochSec(60) * ProtocolTiming.MsPerSecond)
  Assert.equal(Constants.FundedOperatorCount, 1)
  Assert.equal(Constants.EpochDurationSec, 60)
})

test("every rotation retains a strict majority with the funded relay offline", () => {
  const schedule = BatchOperatorSchedule.resolve(new Scenario().defaults),
    liveInAffectedGroup = schedule.operatorsPerEpoch - Constants.FundedOperatorCount
  Assert.equal(schedule.batchOpGroups, 3)
  Assert.equal(schedule.operatorsPerEpoch, 3)
  Assert.ok(liveInAffectedGroup > schedule.operatorsPerEpoch / 2)
  const undersized = BatchOperatorSchedule.resolve({ batchOperatorCount: 3 })
  Assert.ok(undersized.operatorsPerEpoch - Constants.FundedOperatorCount <= undersized.operatorsPerEpoch / 2)
})

test("a record still inside the ten-epoch window is not recovery evidence", () => {
  const log = prunedLog()
  log.envelopes = Array.from({ length: 10 }, (_, index) => record(index + 10))
  Assert.equal(Recovery.hasPrunedCheckpoint(log, original, checkpoint), false)
})

test("empty, incomplete, enlarged and unordered source logs cannot prove expiry", () => {
  Assert.equal(Recovery.hasPrunedCheckpoint({ envelopes: [] }, original, checkpoint), false)
  const short = prunedLog()
  short.envelopes.shift()
  Assert.equal(Recovery.hasPrunedCheckpoint(short, original, checkpoint), false)
  const long = prunedLog()
  long.envelopes.push(record(21))
  Assert.throws(() => Recovery.hasPrunedCheckpoint(long, original, checkpoint), /beyond ten/)
  const unordered = prunedLog()
  unordered.envelopes[1] = record(11)
  Assert.throws(() => Recovery.hasPrunedCheckpoint(unordered, original, checkpoint), /strictly increasing/)
})

test("wrong-chain, unaccepted, old, unavailable and mismatched checkpoints are refused", () => {
  for (const value of [null,
    { ...checkpoint, chain_code: String(SlugName.from("ETHEREUM")) },
    { ...checkpoint, consensus_reached: false },
    { ...checkpoint, epoch_index: original.epoch_index },
    { ...checkpoint, epoch_index: 21 },
    { ...checkpoint, envelope_digest: digest(3) }]) {
    Assert.equal(Recovery.hasPrunedCheckpoint(prunedLog(), original, value), false)
  }
})

test("a malformed source checksum fails loudly", () => {
  const log = prunedLog()
  log.envelopes[0].checksum = [1]
  Assert.throws(() => Recovery.hasPrunedCheckpoint(log, original, checkpoint), /size mismatch/)
})

test("absence means OPEN with zero covered contribution and no bond rows", () => {
  Recovery.assertUnbonded(openRequest(), [])
  Assert.throws(() => Recovery.assertUnbonded(null, []), /disappeared/)
  Assert.throws(() => Recovery.assertUnbonded({ ...openRequest(), state: SysioContracts.SysioBondRequestState.BONDED }, []), /OPEN/)
  Assert.throws(() => Recovery.assertUnbonded({ ...openRequest(), bonded: "1" }, []), /before recovery/)
  Assert.throws(() => Recovery.assertUnbonded(openRequest(), [{ underwriter: "other" }]), /funded node was absent/)
})

test("the funded node selector refuses an experiment with extra funded providers or relays", () => {
  const { ctx } = fixture()
  Assert.equal(Recovery.fundedNode(ctx).name, "relay-0")
  ctx.config.batchOperatorUnderwriting.fundedOperatorCount = 2
  Assert.throws(() => Recovery.fundedNode(ctx))
  ctx.config.batchOperatorUnderwriting.fundedOperatorCount = 1
  mock.method(NodeConfig, "plan", () => nodes().slice(1))
  Assert.throws(() => Recovery.fundedNode(ctx))
})

test("source reads derive the correct PDA and require finalized commitment", async () => {
  const { ctx, holder, connection, programId } = fixture()
  mock.method(connection, "getAccountInfo", async (address, commitment) => {
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("outbound_envelopes")], programId)
    Assert.ok(address.equals(expected))
    Assert.equal(commitment, SolanaClient.ConfirmationStatus.finalized)
    return { owner: programId, data: Buffer.of(1) }
  })
  Assert.equal(await Recovery.readOutboundLog(ctx), holder.log)
})

test("missing accounts, wrong owners and RPC failures never become pruning evidence", async () => {
  const { ctx, connection } = fixture()
  mock.method(connection, "getAccountInfo", async () => null)
  await Assert.rejects(Recovery.readOutboundLog(ctx), /missing finalized/)
  mock.method(connection, "getAccountInfo", async () => ({ owner: Keypair.generate().publicKey }))
  await Assert.rejects(Recovery.readOutboundLog(ctx), /wrong program owner/)
  const failure = new Error("source RPC failed")
  mock.method(connection, "getAccountInfo", async () => { throw failure })
  await Assert.rejects(Recovery.readOutboundLog(ctx), failure)
})

test("capture requires the original source digest and records typed acceptance before pruning", async () => {
  const { ctx, holder } = fixture()
  await Recovery.verifyOriginal(ctx)
  Assert.deepEqual(ctx.outputs.assert(OriginalEnvelope), original)
  holder.log = prunedLog()
  await Assert.rejects(Recovery.verifyOriginal(ctx), /already absent/)
  holder.log = { envelopes: [record(10, 9)] }
  await Assert.rejects(Recovery.verifyOriginal(ctx), /differs/)
})

test("offline observations reject a running provider, mutation and premature bonding", async () => {
  const { ctx, holder } = fixture()
  await Recovery.verifyOriginal(ctx)
  await Recovery.assertStillUnbonded(ctx)
  holder.running = {}
  await Assert.rejects(Recovery.assertStillUnbonded(ctx), /still running/)
  holder.running = null
  holder.original = { ...original, digest: digest(9) }
  await Assert.rejects(Recovery.assertStillUnbonded(ctx), /identity changed/)
  holder.original = { ...original }
  holder.request.bonded = "1"
  await Assert.rejects(Recovery.assertStillUnbonded(ctx), /before recovery/)
})

test("pruning verification saves the authenticated newer checkpoint before restart", async () => {
  const { ctx, holder } = fixture()
  await Recovery.verifyOriginal(ctx)
  holder.log = prunedLog()
  await Recovery.verifyPruned(ctx)
  Assert.deepEqual(ctx.outputs.assert(PrunedCheckpoint), checkpoint)
  Assert.deepEqual(ctx.outputs.assert(PrunedSourceLog), holder.log)
  holder.request.bonded = "1"
  await Assert.rejects(Recovery.verifyPruned(ctx), /before recovery/)
})

test("a failed source read is retried at the slower pruning cadence", async () => {
  const { ctx, holder, connection, programId } = fixture()
  await Recovery.verifyOriginal(ctx)
  holder.log = prunedLog()
  let attempts = 0
  mock.method(connection, "getAccountInfo", async () => {
    if (++attempts === 1) throw new Error("temporary source RPC read failure")
    return { owner: programId, data: Buffer.of(1) }
  })
  mock.timers.enable({ apis: ["setTimeout"] })
  const pending = Recovery.verifyPruned(ctx)
  await new Promise(resolve => setImmediate(resolve))
  Assert.equal(attempts, 1)
  mock.timers.tick(Constants.PruningPollMs - 1)
  await new Promise(resolve => setImmediate(resolve))
  Assert.equal(attempts, 1)
  mock.timers.tick(1)
  await pending
  Assert.equal(attempts, 2)
  Assert.deepEqual(ctx.outputs.assert(PrunedCheckpoint), checkpoint)
  Assert.ok(Constants.PruningPollMs > SyndicationScenario.PollMs)
})

test("a failed depot read yields no pruning evidence and can recover", async () => {
  const { ctx, holder } = fixture()
  await Recovery.verifyOriginal(ctx)
  holder.log = prunedLog()
  const read = mock.method(WireSyndicationTool, "readBonds", async () => {
    throw new Error("temporary depot RPC read failure")
  })
  Assert.equal(await Recovery.readPrunedCheckpoint(ctx), null)
  Assert.ok(ctx.outputs.get(PrunedSourceLog) == null)
  read.mock.restore()
  Assert.deepEqual(await Recovery.readPrunedCheckpoint(ctx), checkpoint)
})

test("poll observations keep premature bonding, identity changes and invalid proofs fatal", async () => {
  const { ctx, holder, connection } = fixture()
  await Recovery.verifyOriginal(ctx)
  holder.log = prunedLog()
  holder.request.bonded = "1"
  await Assert.rejects(Recovery.readPrunedCheckpoint(ctx), /before recovery/)
  holder.request.bonded = "0"
  holder.original = null
  await Assert.rejects(Recovery.readPrunedCheckpoint(ctx), /envelope disappeared/)
  holder.original = { ...original, digest: digest(9) }
  await Assert.rejects(Recovery.readPrunedCheckpoint(ctx), /identity changed/)
  holder.original = { ...original }
  holder.log.envelopes[0].checksum = [1]
  await Assert.rejects(Recovery.readPrunedCheckpoint(ctx), /size mismatch/)
  mock.method(connection, "getAccountInfo", async () => ({ owner: Keypair.generate().publicKey }))
  await Assert.rejects(Recovery.readPrunedCheckpoint(ctx), /wrong program owner/)
})

test("pruning evidence survives a poll that fills its RPC capture and rejects a corrupted proof", async () => {
  const { ctx, holder } = fixture(),
    pollRecorder = new StepExtraRecorder(),
    proofRecorder = new StepExtraRecorder()
  await Recovery.verifyOriginal(ctx)
  holder.log = prunedLog()
  await StepExtraRecorder.runWith(pollRecorder, async () => {
    for (let index = 0; index < StepExtraRecorder.MaxCalls; index++) {
      StepExtraRecorder.note(`earlier poll ${index}`)
    }
    await Recovery.verifyPruned(ctx)
  })
  await StepExtraRecorder.runWith(proofRecorder, () => Recovery.verifyPruningEvidence(ctx))
  const proof = proofRecorder.toExtra().calls.find(call => call.retainedEpochs)
  Assert.equal(proof.requestId, original.request_id)
  Assert.equal(proof.originalEpoch, original.epoch_index)
  Assert.equal(proof.originalDigest, original.digest)
  Assert.deepEqual(proof.retainedEpochs, Array.from({ length: 10 }, (_, index) => index + 11))
  Assert.equal(proof.checkpointEpoch, checkpoint.epoch_index)
  Assert.equal(proof.checkpointDigest, checkpoint.envelope_digest)
  ctx.outputs.set(PrunedSourceLog, { envelopes: [record(original.epoch_index, 1)] })
  await Assert.rejects(Recovery.verifyPruningEvidence(ctx), /does not authenticate/)
})

test("settlement requires the same running node, exact net and fee, and returned capital", async () => {
  const { ctx, holder } = fixture(),
    { Plan } = Constants,
    before = { holder: 10n, fees: 2n, operators: 3n },
    fee = SyndicationScenario.feeOf(Plan.amount, Plan.feeBps)
  ctx.outputs.set(Plan.before, before)
  ctx.outputs.set(PrunedCheckpoint, checkpoint)
  holder.running = {}
  mock.method(Underwriting, "readOperatorsBalance", async () => before.operators)
  mock.method(SyndicationScenario, "readFees", async () => before.fees + fee)
  mock.method(SyndicationScenario, "readBalance", async (_ctx, account) =>
    account === Plan.user.account ? Plan.amount - fee : before.holder + fee)
  await Recovery.verifySettled(ctx)
  holder.running = null
  await Assert.rejects(Recovery.verifySettled(ctx), /did not restart/)
})

test("the planned flow stops before intake and proves pruning before the original node starts", () => {
  const { ctx } = fixture(),
    scenario = new Scenario()
  mock.method(SyndicationScenario.prototype, "planSetup", () => {})
  mock.method(SyndicationScenario.prototype, "planFinish", () => {})
  mock.method(Underwriting, "planConfigureUnderwriting", () => {})
  const build = ClusterBuild.forContext(ctx)
  scenario.plan(build)
  const steps = build.children.flatMap(phase => phase.steps),
    names = steps.map(step => step.name)
  for (const [earlier, later] of [
    ["stop-funded-underwriter", "delayed-syndication"],
    ["delayed-syndication", "original-digest-visible"],
    ["original-digest-visible", "original-digest-pruned"],
    ["original-digest-pruned", "pruning-evidence"],
    ["pruning-evidence", "restart-original-underwriter"],
    ["restart-original-underwriter", "old-request-bonded"],
    ["old-request-bonded", "old-request-approved-and-claimed"],
    ["old-request-approved-and-claimed", "exact-recovery-settlement"]
  ]) Assert.ok(names.indexOf(earlier) < names.indexOf(later), `${earlier} must precede ${later}`)
  const stop = steps.find(step => step.name === "stop-funded-underwriter"),
    start = steps.find(step => step.name === "restart-original-underwriter")
  Assert.equal(stop.input.nodeName, start.input.nodeName)
  Assert.equal(start.input.nodeName, "relay-0")
  Assert.deepEqual(steps.filter(step => step.input != null).map(step => step.input.kind), [
    "NodeopProcessSteps.StopInput", "SolanaLiqSyndicationTool.SyndInput", "NodeopProcessSteps.StartInput"
  ])
  Assert.equal(scenario.defaults.batchOperatorUnderwriting.fundedOperatorCount, 1)
  Assert.equal(scenario.defaults.epochDurationSec, 60)
  Assert.equal(scenario.defaults.underwriterCount, 0)
})
