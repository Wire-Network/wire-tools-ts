const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { NodeConfig, NodeRole } = require("@wireio/cluster-tool")
const {
  BatchRelayRestartScenario: Scenario
} = require("../lib/BatchRelayRestartScenario.js")
afterEach(() => mock.restoreAll())
test("stop reaps and unregisters the real daemon without removing its disk data", async () => {
  const events = [],
    signal = new AbortController().signal
  mock.method(NodeConfig, "plan", () => [
    { role: NodeRole.batch_operator, name: "actual-relay" }
  ])
  const ctx = {
    config: {},
    processManager: {
      get: label => {
        Assert.equal(label, "actual-relay")
        return {
          stop: async value => {
            Assert.equal(value, signal)
            events.push("stopped")
          }
        }
      },
      remove: label => events.push(label)
    }
  }
  await Scenario.runStop(
    ctx,
    { kind: "BatchRelayRestartScenario.StopInput" },
    signal
  )
  Assert.deepEqual(events, ["stopped", "actual-relay"])
})
test("extra relays invalidate the outstanding-work experiment", () => {
  mock.method(NodeConfig, "plan", () => [
    { role: NodeRole.batch_operator },
    { role: NodeRole.batch_operator }
  ])
  Assert.throws(() => Scenario.relayNode({ config: {} }), /exactly one/)
})
test("a missing relay cannot count as a successful interruption", async () => {
  mock.method(NodeConfig, "plan", () => [
    { role: NodeRole.batch_operator, name: "absent" }
  ])
  await Assert.rejects(
    Scenario.runStop(
      { config: {}, processManager: { get: () => null } },
      { kind: "BatchRelayRestartScenario.StopInput" },
      new AbortController().signal
    ),
    /not running/
  )
})
