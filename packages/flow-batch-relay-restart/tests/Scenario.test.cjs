const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { ClusterBuild, NodeConfig, NodeRole, OutputStore } = require("@wireio/cluster-tool")
const {
  BatchRelayRestartScenario: Scenario
} = require("../lib/BatchRelayRestartScenario.js")
afterEach(() => mock.restoreAll())
test("the interruption stops every planned relay and nothing else", () => {
  const relays = [
    { role: NodeRole.batch_operator, name: "node-01" },
    { role: NodeRole.batch_operator, name: "node-02" }
  ]
  mock.method(NodeConfig, "plan", () => [{ role: NodeRole.producer, name: "node-00" }, ...relays])
  Assert.deepEqual(Scenario.relayNodes({ config: {} }), relays)
})
test("a cluster with no relay has nothing to interrupt", () => {
  mock.method(NodeConfig, "plan", () => [{ role: NodeRole.producer, name: "node-00" }])
  Assert.throws(() => Scenario.relayNodes({ config: {} }), /requires a relay/)
})
test("the interruption stops every relay, then restarts each once the payout is seen waiting", () => {
  const relays = [
    { role: NodeRole.batch_operator, name: "node-01" },
    { role: NodeRole.batch_operator, name: "node-02" }
  ]
  mock.method(NodeConfig, "plan", () => [{ role: NodeRole.producer, name: "node-00" }, ...relays])
  const build = ClusterBuild.forContext({ outputs: new OutputStore(), config: {} })
  new Scenario().plan(build)
  const phase = name => build.children.find(child => child.name === name)
  Assert.deepEqual(
    phase("StopRelays").steps.map(step => step.name),
    ["stop-node-01", "stop-node-02"]
  )
  Assert.deepEqual(
    phase("RecoverRelays").steps.map(step => step.name),
    ["payout-awaits-relays", "restart-node-01", "restart-node-02"]
  )
})
