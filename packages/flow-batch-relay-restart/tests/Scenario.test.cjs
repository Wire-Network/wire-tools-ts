const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { NodeConfig, NodeRole } = require("@wireio/cluster-tool")
const {
  BatchRelayRestartScenario: Scenario
} = require("../lib/BatchRelayRestartScenario.js")
afterEach(() => mock.restoreAll())
test("extra relays invalidate the outstanding-work experiment", () => {
  mock.method(NodeConfig, "plan", () => [
    { role: NodeRole.batch_operator },
    { role: NodeRole.batch_operator }
  ])
  Assert.throws(() => Scenario.relayNode({ config: {} }), /exactly one/)
})
