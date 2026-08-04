import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import { createReadinessCommand } from "@wireio/cluster-tool/cli/ReadinessCommand"

describe("createReadinessCommand", () => {
  it("registers readiness through the framework-native command surface", () => {
    const command = createReadinessCommand()
    expect(command.command).toBe(ClusterCommand.readiness)
    expect(typeof command.describe).toBe("string")
    expect(typeof command.builder).toBe("function")
    expect(typeof command.handler).toBe("function")
  })
})
