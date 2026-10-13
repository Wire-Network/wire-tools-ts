import { EthereumDeploymentKind } from "@wireio/cluster-tool-shared"
import { SlashingScenario } from "@wireio/test-flow-batch-operator-slashing/SlashingScenario.js"

describe("SlashingScenario", () => {
  it("disputes and slashes against the outpost the go-live deployed over the pre-launch ladder", () => {
    expect(new SlashingScenario().defaults.ethereumDeployment).toBe(EthereumDeploymentKind.ladder)
  })
})
