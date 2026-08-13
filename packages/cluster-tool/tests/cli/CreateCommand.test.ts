import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { Argv } from "yargs"
import { AWSAccountName, SignatureProviderType } from "@wireio/cluster-tool-shared"

const createMock = jest.fn()

// Preserve every other `ClusterManager` member (launch/stop/destroy) via the
// real module — only `create` is faked, mirroring the established
// `jest.requireActual` spread pattern (see BindConfigProvider.test.ts's netUtils mock).
jest.mock("@wireio/cluster-tool/cluster/ClusterManager", () => ({
  ClusterManager: {
    ...(
      jest.requireActual(
        "@wireio/cluster-tool/cluster/ClusterManager"
      ) as typeof import("@wireio/cluster-tool/cluster/ClusterManager")
    ).ClusterManager,
    create: createMock
  }
}))

import {
  AWSClusterNodeConfigFlag,
  ClusterBuildOptionsFileFlag
} from "@wireio/cluster-tool/cli/ClusterBuildOptionsArgs"
import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import { createCreateCommand } from "@wireio/cluster-tool/cli/CreateCommand"
import type { ClusterBuildOptions } from "@wireio/cluster-tool/config"

/** The recorder pair returned by {@link createYargsRecorder}. */
interface YargsRecorder {
  argv: Argv
  options: Map<string, unknown>
}

/** One captured `.option(flag, config)` registration (only `default` is asserted on). */
interface RecordedOption {
  default?: unknown
}

/** A minimal `.option()`-recording `Argv` stand-in (yargs is ESM-only; see
 *  ClusterBuildOptionsArgs.test.ts). */
function createYargsRecorder(): YargsRecorder {
  const options = new Map<string, unknown>(),
    recorder = {
      option(flag: string, config: unknown) {
        options.set(flag, config)
        return recorder
      }
    }
  return { argv: recorder as Argv, options }
}

describe("createCreateCommand", () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>
  let dir: string

  beforeEach(() => {
    createMock.mockReset()
    createMock.mockResolvedValue({ succeeded: true })
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "create-command-"))
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Write a `--cluster-build-options-file` document, returning its path. */
  function writeOptionsFile(document: unknown): string {
    const file = Path.join(dir, "cluster-build-options.json")
    Fs.writeFileSync(file, JSON.stringify(document))
    return file
  }

  /** Write an `--aws-cluster-node-config` document, returning its path. */
  function writeNodeConfigFile(document: unknown): string {
    const file = Path.join(dir, "aws-cluster-node-config.json")
    Fs.writeFileSync(file, JSON.stringify(document))
    return file
  }

  /** The registered `default` for one flag of a command built from `commandLine`. */
  function registeredDefault(commandLine: string[], flag: string): unknown {
    const { argv, options } = createYargsRecorder()
    createCreateCommand(commandLine).builder(argv)
    return (options.get(flag) as RecordedOption)?.default
  }

  /** The options `ClusterManager.create` was called with. */
  function createdOptions(): ClusterBuildOptions {
    return createMock.mock.calls[0][0] as ClusterBuildOptions
  }

  it("names itself with the create enum member and carries a non-empty describe", () => {
    const module = createCreateCommand()
    expect(module.command).toBe(ClusterCommand.create)
    expect(
      typeof module.describe === "string" && module.describe.length > 0
    ).toBe(true)
  })

  it("builder delegates to applyClusterBuildOptionsArgs (registers the shared flag surface)", () => {
    const { argv, options } = createYargsRecorder()
    createCreateCommand().builder(argv)
    expect(options.has("cluster-path")).toBe(true)
    expect(options.has("build-path")).toBe(true)
    expect(options.has("epoch-duration-sec")).toBe(true)
    expect(options.has("enable-mock-reserves")).toBe(true)
    // out-of-shape flags — registered so `.strict()` accepts them + `--help` lists them
    expect(options.has(ClusterBuildOptionsFileFlag)).toBe(true)
    expect(options.has(AWSClusterNodeConfigFlag)).toBe(true)
  })

  it("seeds every flag default from the --cluster-build-options-file document", () => {
    const file = writeOptionsFile({
      clusterPath: "/tmp/from-file",
      epochDurationSec: 42,
      batchOperatorCount: 9
    })
    const commandLine = ["create", `--${ClusterBuildOptionsFileFlag}`, file]
    expect(registeredDefault(commandLine, "cluster-path")).toBe("/tmp/from-file")
    expect(registeredDefault(commandLine, "epoch-duration-sec")).toBe(42)
    expect(registeredDefault(commandLine, "batch-operator-count")).toBe(9)
  })

  it("the file beats the WIRE_* environment (env is the lower layer for create)", () => {
    const previousCluster = process.env.WIRE_CLUSTER_PATH,
      previousBuild = process.env.WIRE_BUILD_PATH
    process.env.WIRE_CLUSTER_PATH = "/tmp/from-env"
    process.env.WIRE_BUILD_PATH = "/tmp/build-from-env"
    try {
      const file = writeOptionsFile({ clusterPath: "/tmp/from-file" }),
        commandLine = ["create", `--${ClusterBuildOptionsFileFlag}=${file}`]
      expect(registeredDefault(commandLine, "cluster-path")).toBe(
        "/tmp/from-file"
      )
      // …and the env still seeds a leaf the document does not carry
      expect(registeredDefault(commandLine, "build-path")).toBe(
        "/tmp/build-from-env"
      )
    } finally {
      if (previousCluster == null) delete process.env.WIRE_CLUSTER_PATH
      else process.env.WIRE_CLUSTER_PATH = previousCluster
      if (previousBuild == null) delete process.env.WIRE_BUILD_PATH
      else process.env.WIRE_BUILD_PATH = previousBuild
    }
  })

  it("keeps the loaded document per-command — a second command sees none of it", () => {
    const file = writeOptionsFile({ epochDurationSec: 42 })
    expect(
      registeredDefault(["create", `--${ClusterBuildOptionsFileFlag}`, file], "epoch-duration-sec")
    ).toBe(42)
    // a fresh command built from a bare command line falls back to the CLI default
    expect(registeredDefault(["create"], "epoch-duration-sec")).toBe(60)
  })

  it("passes the document as the reverse-parse defaults so the flag-less collateral carries", async () => {
    const requiredBatchOperatorCollateral = [
      { chainCode: 11, tokenCode: 22, minimumBond: 2_000_000 }
    ]
    const file = writeOptionsFile({ requiredBatchOperatorCollateral })
    await createCreateCommand([
      "create",
      `--${ClusterBuildOptionsFileFlag}`,
      file
    ]).handler({ "cluster-path": "/tmp/wire-cluster" })
    expect(createdOptions().requiredBatchOperatorCollateral).toEqual(
      requiredBatchOperatorCollateral
    )
  })

  it("merges --aws-cluster-node-config, and its ssm becomes the lowest-precedence SSM source", async () => {
    const nodeConfigFile = writeNodeConfigFile({
      account: AWSAccountName.dev,
      regions: ["us-east-1"],
      ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
    })
    await createCreateCommand(["create"]).handler({
      "cluster-path": "/tmp/wire-cluster",
      [AWSClusterNodeConfigFlag]: nodeConfigFile
    })
    const options = createdOptions()
    expect(options.awsClusterNodeConfig?.account).toBe(AWSAccountName.dev)
    expect(options.signatureProvider?.ssm?.awsSecretIdPattern).toBe(
      "/wire/{cluster}/{account}/{keyType}"
    )
  })

  it("lets the document's signatureProvider.ssm outrank the node config's", async () => {
    const nodeConfigFile = writeNodeConfigFile({
        account: AWSAccountName.dev,
        regions: ["us-east-1"],
        ssm: { awsSecretIdPattern: "/node-config/{account}" }
      }),
      file = writeOptionsFile({
        signatureProvider: {
          type: SignatureProviderType.SSM,
          ssm: { awsSecretIdPattern: "/document/{account}" }
        }
      })
    await createCreateCommand([
      "create",
      `--${ClusterBuildOptionsFileFlag}`,
      file
    ]).handler({
      "cluster-path": "/tmp/wire-cluster",
      [AWSClusterNodeConfigFlag]: nodeConfigFile
    })
    expect(createdOptions().signatureProvider?.ssm?.awsSecretIdPattern).toBe(
      "/document/{account}"
    )
  })

  it("rejects a clusterPath authored by BOTH the document and an explicit --cluster-path", async () => {
    const file = writeOptionsFile({ clusterPath: "/tmp/from-file" })
    await expect(
      createCreateCommand([
        "create",
        `--${ClusterBuildOptionsFileFlag}`,
        file,
        "--cluster-path",
        "/tmp/from-flag"
      ]).handler({ "cluster-path": "/tmp/from-flag" })
    ).rejects.toThrow(/clusterPath is authored twice/)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("accepts a document clusterPath alongside an ambient WIRE_CLUSTER_PATH", async () => {
    const previous = process.env.WIRE_CLUSTER_PATH
    process.env.WIRE_CLUSTER_PATH = "/tmp/from-env"
    try {
      const file = writeOptionsFile({ clusterPath: "/tmp/from-file" })
      await createCreateCommand([
        "create",
        `--${ClusterBuildOptionsFileFlag}`,
        file
      ]).handler({ "cluster-path": "/tmp/from-file" })
      expect(createMock).toHaveBeenCalledTimes(1)
    } finally {
      if (previous == null) delete process.env.WIRE_CLUSTER_PATH
      else process.env.WIRE_CLUSTER_PATH = previous
    }
  })

  it("exits 0 and logs SUCCEEDED when the bootstrap report succeeded", async () => {
    createMock.mockResolvedValue({ succeeded: true })
    await createCreateCommand().handler({
      "cluster-path": "/tmp/wire-cluster",
      "build-path": "/tmp/wire-build",
      "ethereum-path": "/tmp/wire-eth",
      "solana-path": "/tmp/wire-sol"
    })
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("exits 1 when the bootstrap report did not succeed", async () => {
    createMock.mockResolvedValue({ succeeded: false })
    await createCreateCommand().handler({})
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
