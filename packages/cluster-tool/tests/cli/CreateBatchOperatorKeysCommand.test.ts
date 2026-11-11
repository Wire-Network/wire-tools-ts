import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { Argv } from "yargs"
import { KeyType } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import { getLoggingManager } from "@wireio/shared"
import {
  AWSAccountName,
  ClusterSignatureProviderTypes,
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type KeyCustodySettings
} from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import {
  applyClusterBuildOptionsArgs,
  AWSClusterNodeConfigFlag,
  ClusterBuildOptionsFileFlag,
  SignatureProviderKMSFlag,
  SignatureProviderSSMFlag
} from "@wireio/cluster-tool/cli/ClusterBuildOptionsArgs"
import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import {
  createCreateBatchOperatorKeysCommand,
  runCreateBatchOperatorKeys,
  toCreateBatchOperatorKeysOptions
} from "@wireio/cluster-tool/cli/CreateBatchOperatorKeysCommand"
import {
  ClusterConfigProvider,
  type ClusterBuildOptions
} from "@wireio/cluster-tool/config"
import { StdoutAppender } from "@wireio/cluster-tool/logging"
import type { OperatorAccount } from "@wireio/cluster-tool/orchestration/outputs"
import { BatchOperatorKeyTool } from "@wireio/cluster-tool/tools/wire/BatchOperatorKeyTool"
import { fixtureOperatorAccount } from "../orchestration/outputs/operatorAccountFixture.js"

/** A captured `.option()` config — only the fields this suite asserts on. */
interface RecordedOption {
  type?: string
  demandOption?: boolean
  default?: unknown
  describe?: string
  choices?: readonly string[]
  alias?: string
}

/** The recorder pair returned by {@link createYargsRecorder}. */
interface YargsRecorder {
  argv: Argv
  options: Map<string, RecordedOption>
}

/** A minimal `.option()`-recording `Argv` stand-in (yargs is ESM-only; see CreateApiNodeCommand.test.ts). */
function createYargsRecorder(): YargsRecorder {
  const options = new Map<string, RecordedOption>(),
    recorder = {
      option(flag: string, config: RecordedOption) {
        options.set(flag, config)
        return recorder
      }
    }
  return { argv: recorder as Argv, options }
}

/** Record the whole flag surface the builder registers for `commandLine`. */
function recordBuilder(commandLine: string[] = []): Map<string, RecordedOption> {
  const recorder = createYargsRecorder()
  createCreateBatchOperatorKeysCommand(commandLine).builder(recorder.argv)
  return recorder.options
}

const BatchOperatorCountFlag = "batch-operator-count",
  SignatureProviderTypeFlag = "signature-provider-type",
  SecretIdPattern = "/wire/{cluster}/{account}/{keyType}",
  KmsAliasPattern = "alias/wire/{cluster}/{account}/{keyType}",
  KmsRegion = "us-east-1",
  SSMJson = `{"awsSecretIdPattern":"${SecretIdPattern}"}`,
  KmsJson = `{"awsKeyAliasPattern":"${KmsAliasPattern}","awsRegion":"${KmsRegion}"}`

/** The SSM + kms build options a pre-creation resolves its settings from. */
function ssmKmsOptions(batchOperatorCount?: number): ClusterBuildOptions {
  return {
    ...(batchOperatorCount == null ? {} : { batchOperatorCount }),
    signatureProvider: {
      type: SignatureProviderType.SSM,
      ssm: { awsSecretIdPattern: SecretIdPattern },
      kms: { awsKeyAliasPattern: KmsAliasPattern, awsRegion: KmsRegion }
    },
    awsClusterNodeConfig: {
      account: AWSAccountName.dev,
      regions: [KmsRegion, "eu-west-1"],
      ssm: null,
      kms: null
    }
  }
}

/** The identities the (doubled) tool hands back for `labels`. */
function operatorsFor(labels: readonly string[]): OperatorAccount[] {
  return labels.map(label => fixtureOperatorAccount(label, OperatorType.BATCH, label))
}

/** A doubled listing — one PUBLIC row per label, enough to prove the plumbing. */
function listingFor(operators: readonly OperatorAccount[]): BatchOperatorKeyTool.KeyListing[] {
  return operators.map(operator => ({
    label: operator.label,
    keyType: KeyType.K1,
    publicKey: operator.wire.publicKey,
    custody: `SSM:/wire/dev/${operator.label}/K1`
  }))
}

describe("createCreateBatchOperatorKeysCommand", () => {
  it("names itself with the create-batch-operator-keys enum member and carries a non-empty describe", () => {
    const module = createCreateBatchOperatorKeysCommand()
    expect(module.command).toBe(ClusterCommand["create-batch-operator-keys"])
    expect(
      typeof module.describe === "string" && module.describe.length > 0
    ).toBe(true)
  })

  it("exposes the full yargs command module shape the parser chain registers", () => {
    // `cli/index.ts` self-executes `main()` on import, so the registration
    // contract is asserted through the module's shape (every sibling command
    // suite does the same); the enum member is pinned in ClusterCommand.test.ts.
    const module = createCreateBatchOperatorKeysCommand()
    expect(typeof module.builder).toBe("function")
    expect(typeof module.handler).toBe("function")
  })

  it("registers EXACTLY the two shared leaves plus the four document flags — no cluster surface", () => {
    const options = recordBuilder()
    expect([...options.keys()].sort()).toEqual(
      [
        BatchOperatorCountFlag,
        SignatureProviderTypeFlag,
        ClusterBuildOptionsFileFlag,
        AWSClusterNodeConfigFlag,
        SignatureProviderSSMFlag,
        SignatureProviderKMSFlag
      ].sort()
    )
    expect(options.has("cluster-path")).toBe(false)
    expect(options.has("build-path")).toBe(false)
    ;[
      ClusterBuildOptionsFileFlag,
      AWSClusterNodeConfigFlag,
      SignatureProviderSSMFlag,
      SignatureProviderKMSFlag
    ].forEach(flag => {
      expect(options.get(flag).type).toBe("string")
      expect(options.get(flag).describe.length).toBeGreaterThan(0)
    })
  })

  it("takes the two shared leaves from the SAME buildOptionShape entries create uses — identical describe, choices and defaults", () => {
    const keys = recordBuilder(),
      create = createYargsRecorder()
    // An EMPTY environment keeps a developer shell's WIRE_* exports out of create's registration.
    applyClusterBuildOptionsArgs(create.argv, {}, {})
    ;[BatchOperatorCountFlag, SignatureProviderTypeFlag].forEach(flag =>
      expect(keys.get(flag)).toEqual(create.options.get(flag))
    )
    expect(keys.get(SignatureProviderTypeFlag).choices).toEqual([
      ...ClusterSignatureProviderTypes
    ])
    expect(keys.get(SignatureProviderTypeFlag).choices).not.toContain(
      SignatureProviderType.KMS
    )
    expect(keys.get(SignatureProviderTypeFlag).default).toBe(SignatureProviderType.KEY)
    expect(keys.get(BatchOperatorCountFlag).default).toBe(
      ClusterConfigProvider.DefaultBatchOperatorCount
    )
  })

  it("seeds the shared leaves' defaults from the --cluster-build-options-file named on the raw command line", () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "batch-operator-keys-cmd-")),
      file = Path.join(dir, "cluster-build-options.json")
    Fs.writeFileSync(
      file,
      JSON.stringify({
        batchOperatorCount: 9,
        signatureProvider: { type: SignatureProviderType.SSM }
      })
    )
    try {
      const options = recordBuilder([
        ClusterCommand["create-batch-operator-keys"],
        `--${ClusterBuildOptionsFileFlag}`,
        file
      ])
      expect(options.get(BatchOperatorCountFlag).default).toBe(9)
      expect(options.get(SignatureProviderTypeFlag).default).toBe(
        SignatureProviderType.SSM
      )
    } finally {
      Fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("toCreateBatchOperatorKeysOptions", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "batch-operator-keys-options-"))
  })

  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Write an `AWSClusterNodeConfig` carrying its own ssm + kms and return its path. */
  function writeNodeConfig(): string {
    const file = Path.join(dir, "aws-cluster-node-config.json")
    Fs.writeFileSync(
      file,
      JSON.stringify({
        account: AWSAccountName.test,
        regions: [KmsRegion],
        ssm: { awsSecretIdPattern: "/node-config/{cluster}/{account}/{keyType}" },
        kms: { awsKeyAliasPattern: "alias/node-config/{account}", awsRegion: KmsRegion }
      })
    )
    return file
  }

  it("maps the shared leaves through the ONE argv→options mapper and merges the node config", () => {
    const options = toCreateBatchOperatorKeysOptions(
      {
        [BatchOperatorCountFlag]: 9,
        [SignatureProviderTypeFlag]: SignatureProviderType.SSM,
        [AWSClusterNodeConfigFlag]: writeNodeConfig()
      },
      {}
    )
    expect(options.batchOperatorCount).toBe(9)
    expect(options.signatureProvider.type).toBe(SignatureProviderType.SSM)
    expect(options.awsClusterNodeConfig.account).toBe(AWSAccountName.test)
    // With no flag and no document, the node config's own ssm / kms are the settings.
    expect(options.signatureProvider.ssm.awsSecretIdPattern).toBe(
      "/node-config/{cluster}/{account}/{keyType}"
    )
    expect(options.signatureProvider.kms.awsKeyAliasPattern).toBe(
      "alias/node-config/{account}"
    )
  })

  it("applies create's precedence to BOTH ssm and kms: flag > document > node config", () => {
    const fileOptions: ClusterBuildOptions = {
        signatureProvider: {
          ssm: { awsSecretIdPattern: "/file/{cluster}/{account}/{keyType}" },
          kms: { awsKeyAliasPattern: "alias/file/{account}", awsRegion: KmsRegion }
        }
      },
      nodeConfigFile = writeNodeConfig(),
      fromFlags = toCreateBatchOperatorKeysOptions(
        {
          [SignatureProviderTypeFlag]: SignatureProviderType.SSM,
          [AWSClusterNodeConfigFlag]: nodeConfigFile,
          [SignatureProviderSSMFlag]: SSMJson,
          [SignatureProviderKMSFlag]: KmsJson
        },
        fileOptions
      ),
      fromDocument = toCreateBatchOperatorKeysOptions(
        {
          [SignatureProviderTypeFlag]: SignatureProviderType.SSM,
          [AWSClusterNodeConfigFlag]: nodeConfigFile
        },
        fileOptions
      )
    expect(fromFlags.signatureProvider.ssm.awsSecretIdPattern).toBe(SecretIdPattern)
    expect(fromFlags.signatureProvider.kms.awsKeyAliasPattern).toBe(KmsAliasPattern)
    expect(fromDocument.signatureProvider.ssm.awsSecretIdPattern).toBe(
      "/file/{cluster}/{account}/{keyType}"
    )
    expect(fromDocument.signatureProvider.kms.awsKeyAliasPattern).toBe(
      "alias/file/{account}"
    )
  })

  it("leaves ssm / kms unset when no source carries them", () => {
    const options = toCreateBatchOperatorKeysOptions(
      { [SignatureProviderTypeFlag]: SignatureProviderType.KEY },
      {}
    )
    expect(options.signatureProvider).toEqual({ type: SignatureProviderType.KEY })
    expect(options.awsClusterNodeConfig).toBeUndefined()
  })
})

describe("runCreateBatchOperatorKeys", () => {
  let resolveKeyCustody: jest.SpyInstance,
    adoptOrCreate: jest.SpyInstance,
    toListing: jest.SpyInstance

  beforeEach(() => {
    resolveKeyCustody = jest.spyOn(ClusterConfigProvider, "resolveKeyCustody")
    adoptOrCreate = jest
      .spyOn(BatchOperatorKeyTool, "adoptOrCreate")
      .mockImplementation(async (_settings, labels) => operatorsFor(labels))
    toListing = jest
      .spyOn(BatchOperatorKeyTool, "toListing")
      .mockImplementation((_settings, operators) => listingFor(operators))
  })

  afterEach(() => jest.restoreAllMocks())

  it("resolves the custody settings, adopts-or-creates every bootstrap batch operator's keys with a tooling-less context, and returns their listing", async () => {
    const options = ssmKmsOptions(),
      listing = await runCreateBatchOperatorKeys(options)
    expect(resolveKeyCustody).toHaveBeenCalledWith(options)
    const settings: KeyCustodySettings = resolveKeyCustody.mock.results[0].value
    expect(settings.signatureProvider.kms).toEqual(options.signatureProvider.kms)
    // The default roster: 3 operators, in label order — K1 / ED / EM need no wire-sysio build.
    expect(adoptOrCreate).toHaveBeenCalledTimes(1)
    expect(adoptOrCreate).toHaveBeenCalledWith(
      settings,
      Constants.batchOperatorLabels(ClusterConfigProvider.DefaultBatchOperatorCount),
      KeyGenerator.context()
    )
    expect(adoptOrCreate.mock.calls[0][2]).toEqual({})
    // The listing is rendered from the SAME settings and the adopted identities.
    const adopted = await adoptOrCreate.mock.results[0].value
    expect(toListing).toHaveBeenCalledWith(settings, adopted)
    expect(listing).toEqual(listingFor(adopted))
    expect(listing.map(row => row.label)).toEqual(Constants.batchOperatorLabels(3))
  })

  it("sizes the roster from batchOperatorCount", async () => {
    await runCreateBatchOperatorKeys(ssmKmsOptions(9))
    expect(adoptOrCreate.mock.calls[0][1]).toEqual(Constants.batchOperatorLabels(9))
    expect(adoptOrCreate.mock.calls[0][1]).toHaveLength(9)
  })

  it("propagates a custody-settings resolution failure BEFORE any key is touched", async () => {
    await expect(
      runCreateBatchOperatorKeys({
        signatureProvider: {
          type: SignatureProviderType.KEY,
          kms: { awsKeyAliasPattern: KmsAliasPattern, awsRegion: KmsRegion }
        }
      })
    ).rejects.toThrow(/signatureProvider\.kms is only valid when type is SSM/)
    expect(adoptOrCreate).not.toHaveBeenCalled()
    expect(toListing).not.toHaveBeenCalled()
  })

  it("does NOT consult the batch-operator key policy — an adoptOnly cluster's pre-creation still runs", async () => {
    await runCreateBatchOperatorKeys({
      ...ssmKmsOptions(),
      signatureProvider: {
        ...ssmKmsOptions().signatureProvider,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOnly
      }
    })
    expect(adoptOrCreate).toHaveBeenCalledTimes(1)
    const settings: KeyCustodySettings = adoptOrCreate.mock.calls[0][0]
    expect(settings.signatureProvider.batchOperatorKeyPolicy).toBe(
      SignatureProviderKeyPolicy.adoptOnly
    )
  })
})

describe("createCreateBatchOperatorKeysCommand handler (end to end)", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "batch-operator-keys-handler-"))
  })

  afterEach(() => {
    getLoggingManager().setAppenders([])
    jest.restoreAllMocks()
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("prints the PUBLIC listing as JSON on the stdout data channel, logs the completion, and exits 0", async () => {
    const nodeConfigFile = Path.join(dir, "aws-cluster-node-config.json"),
      operators = operatorsFor(Constants.batchOperatorLabels(3)),
      listing = listingFor(operators),
      exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never),
      // The data channel is observed at its appender (`process.stdout` belongs
      // to the appenders alone; the raw write is StdoutAppender's own contract).
      stdoutAppend = jest
        .spyOn(StdoutAppender.prototype, "append")
        .mockImplementation(() => undefined),
      consoleInfo = jest.spyOn(console, "info").mockImplementation(() => undefined),
      adoptOrCreate = jest
        .spyOn(BatchOperatorKeyTool, "adoptOrCreate")
        .mockResolvedValue(operators)
    jest.spyOn(BatchOperatorKeyTool, "toListing").mockReturnValue(listing)
    Fs.writeFileSync(
      nodeConfigFile,
      JSON.stringify({ account: AWSAccountName.dev, regions: [KmsRegion] })
    )

    await createCreateBatchOperatorKeysCommand().handler({
      [SignatureProviderTypeFlag]: SignatureProviderType.SSM,
      [SignatureProviderSSMFlag]: SSMJson,
      [SignatureProviderKMSFlag]: KmsJson,
      [AWSClusterNodeConfigFlag]: nodeConfigFile
    })

    // The argv reached the resolver: the flags' ssm + kms and the file's placement.
    const settings: KeyCustodySettings = adoptOrCreate.mock.calls[0][0]
    expect(settings.signatureProvider.kms.awsKeyAliasPattern).toBe(KmsAliasPattern)
    expect(settings.awsClusterNodeConfig.account).toBe(AWSAccountName.dev)

    // The data channel carries the listing as ONE pretty-printed JSON document.
    const dataRecords = stdoutAppend.mock.calls
      .map(([record]) => record)
      .filter(record => StdoutAppender.isStdoutCategory(record.category))
    expect(dataRecords).toHaveLength(1)
    expect(dataRecords[0].message).toBe(JSON.stringify(listing, null, 2))
    expect(JSON.parse(dataRecords[0].message)).toEqual(listing)
    // The completion line is a diagnostic, never on the data channel.
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining("3 keys ready for 1 batch operators")
    )
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
