import { ClusterPackageType } from "@wireio/cluster-tool"
import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import {
  createPackageCommand,
  toClusterPackageType
} from "@wireio/cluster-tool/cli/PackageCommand"

describe("toClusterPackageType", () => {
  it("coerces case-insensitively (lower/upper/mixed) to the enum member", () => {
    expect(toClusterPackageType("zip")).toBe(ClusterPackageType.ZIP)
    expect(toClusterPackageType("ZIP")).toBe(ClusterPackageType.ZIP)
    expect(toClusterPackageType("ZiP")).toBe(ClusterPackageType.ZIP)
  })

  it("throws on an unknown package type", () => {
    expect(() => toClusterPackageType("tar")).toThrow(/unknown --package-type/)
  })
})

describe("createPackageCommand", () => {
  it("is the `package` command with a builder + handler", () => {
    const command = createPackageCommand()
    expect(command.command).toBe(ClusterCommand.package)
    expect(typeof command.describe).toBe("string")
    expect(typeof command.builder).toBe("function")
    expect(typeof command.handler).toBe("function")
  })
})
