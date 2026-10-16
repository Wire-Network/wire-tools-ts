const Assert = require("node:assert/strict")
const { test } = require("node:test")
const { EthereumDeploymentKind } = require("@wireio/cluster-tool-shared")
const { CollateralLifecycleScenario } = require("../lib/CollateralLifecycleScenario.js")

test("bonds and delivers against the outpost the go-live deployed over the pre-launch ladder", () => {
  Assert.equal(new CollateralLifecycleScenario().defaults.ethereumDeployment, EthereumDeploymentKind.ladder)
})
