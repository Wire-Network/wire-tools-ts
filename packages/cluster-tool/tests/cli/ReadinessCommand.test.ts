import type { Argv } from "yargs"

import { ClusterReadinessFeature } from "@wireio/cluster-tool-shared"
import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import {
  createReadinessCommand,
  type ReadinessArgv
} from "@wireio/cluster-tool/cli/ReadinessCommand"

interface YargsRecorder {
  argv: Argv
  options: Map<string, unknown>
  validate(args: Partial<ReadinessArgv>): true
}

function createYargsRecorder(): YargsRecorder {
  const options = new Map<string, unknown>()
  let validation = (_args: Partial<ReadinessArgv>): true => true
  const recorder = {
    option(flag: string, config: unknown) {
      options.set(flag, config)
      return recorder
    },
    check(callback: typeof validation) {
      validation = callback
      return recorder
    }
  }
  return {
    argv: recorder as unknown as Argv,
    options,
    validate: args => validation(args)
  }
}

describe("createReadinessCommand", () => {
  it("registers readiness through the framework-native command surface", () => {
    const command = createReadinessCommand()
    expect(command.command).toBe(ClusterCommand.readiness)
    expect(typeof command.describe).toBe("string")
    expect(typeof command.builder).toBe("function")
    expect(typeof command.handler).toBe("function")
  })

  it("registers and requires the immutable deployment-profile file", () => {
    const command = createReadinessCommand(),
      recorder = createYargsRecorder(),
      baseArgs: Partial<ReadinessArgv> = {
        feature: ClusterReadinessFeature.swap,
        json: false,
        color: false,
        export: false
      }
    command.builder(recorder.argv)

    expect(
      recorder.options.get("outpost-deployment-profile-file")
    ).toMatchObject({
      type: "string",
      describe:
        "Immutable outpost deployment-profile JSON used for exact verification"
    })
    expect(() => recorder.validate(baseArgs)).toThrow(
      "Provide --outpost-deployment-profile-file"
    )
    expect(
      recorder.validate({
        ...baseArgs,
        outpostDeploymentProfileFile: "/tmp/outpost-deployment-profile.json"
      })
    ).toBe(true)
  })
})
