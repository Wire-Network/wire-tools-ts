import Path from "node:path"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { AWSAccountName, SignatureProviderType } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import { fixtureResolveEnvironment, type ResolveEnvironment } from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames } from "./clusterBuildFixture.js"

const mockSend = jest.fn()
// An SSM cluster ADOPTS its genesis keys from their parameters during config
// resolution (`ClusterConfigProvider.resolveWithBiosKeys`), so a suite that
// only asserts PHASE ORDERING still performs that read — answer it locally
// rather than reaching for real AWS credentials. Answering every id keeps
// generation (and its `clio` / `sys-util` shell-outs, which the fixture's
// build dir only stubs) out of the picture entirely.
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetParameterCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: "GetParameter", input })),
  PutParameterCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: "PutParameter", input }))
}))

/** The captured command input — only the parameter id is read here. */
interface MockCommandInput {
  Name: string
}

/** The shape the mocked `@aws-sdk/client-ssm` command constructors produce. */
interface MockCommand {
  kind: string
  input: MockCommandInput
}

/** SSM parameter `Type` carrying an encrypted value (the only type read). */
const SecureStringType = "SecureString"

/** The deterministic dev private key, chain-native, for the curve `secretId` names. */
function publishedKey(secretId: string): string {
  const keyType = secretId.slice(secretId.lastIndexOf("/") + 1)
  return PrivateKey.from(
    keyType === KeyType[KeyType.BLS] ? Constants.DEV_BLS_PRIVATE_KEY : Constants.DEV_K1_PRIVATE_KEY
  ).toNativeString()
}

describe("ClusterBuildDefaults — SSM signature-provider key-publication gating", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("ssm-publish-")
    mockSend.mockReset()
    mockSend.mockImplementation(async ({ kind, input }: MockCommand) =>
      kind === "GetParameter"
        ? {
            Parameter: {
              Type: SecureStringType,
              Value: publishedKey(input.Name)
            }
          }
        : {}
    )
  })

  afterEach(() => {
    environment.cleanup()
  })

  function baseOptions() {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    }
  }

  function ssmOptions() {
    return {
      ...baseOptions(),
      signatureProvider: {
        type: SignatureProviderType.SSM,
        // No `awsRegions` — they derive from awsClusterNodeConfig.regions.
        ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
      },
      awsClusterNodeConfig: {
        account: AWSAccountName.dev,
        regions: ["us-east-1", "eu-west-1"],
        ssm: null
      }
    }
  }

  it("omits both publish phases under the default KEY provider", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectPhaseNames(cluster.children)
    expect(names).not.toContain("PublishNodeSignatureProviderKeys")
    expect(names).not.toContain("PublishOperatorSignatureProviderKeys")
  })

  it("publishes node keys AFTER WalletAndKeys and BEFORE any node starts (SSM)", async () => {
    const cluster = await ClusterBuildDefaults.create(ssmOptions())
    const names = collectPhaseNames(cluster.children)
    const publishIndex = names.indexOf("PublishNodeSignatureProviderKeys")
    expect(publishIndex).toBe(names.indexOf("WalletAndKeys") + 1)
    // The consumers — the SSM-spec'd producer nodes — start strictly after.
    expect(publishIndex).toBeLessThan(names.indexOf("BiosNode"))
    expect(publishIndex).toBeLessThan(names.indexOf("ProducerNodes"))
  })

  it("publishes operator keys AFTER provisioning and BEFORE the operator daemons start (SSM)", async () => {
    const cluster = await ClusterBuildDefaults.create(ssmOptions())
    const names = collectPhaseNames(cluster.children)
    const publishIndex = names.indexOf("PublishOperatorSignatureProviderKeys")
    expect(publishIndex).toBeGreaterThan(names.indexOf("Create batchops & uws"))
    expect(publishIndex).toBeLessThan(names.indexOf("OperatorNodes"))
  })
})
