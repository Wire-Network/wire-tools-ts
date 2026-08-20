import Path from "node:path"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { AWSAccountName, SignatureProviderType } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import { fixtureResolveEnvironment, type ResolveEnvironment } from "../config/resolveEnvironmentFixture.js"
import { collectStepNames } from "./clusterBuildFixture.js"

const mockSend = jest.fn()
// An SSM cluster ADOPTS its genesis keys during config resolution, so even a
// composition-only suite performs that read — answer it locally rather than
// reaching for real AWS credentials (same rationale as the key-publication suite).
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

/** Steps that fund an operator's ETH wallet, by the factory's name suffix. */
const EthereumFundingStepSuffix = "-fund-ethereum"

/** The deterministic dev private key, chain-native, for the curve `secretId` names. */
function publishedKey(secretId: string): string {
  const keyType = secretId.slice(secretId.lastIndexOf("/") + 1)
  return PrivateKey.from(
    keyType === KeyType[KeyType.BLS] ? Constants.DEV_BLS_PRIVATE_KEY : Constants.DEV_K1_PRIVATE_KEY
  ).toNativeString()
}

describe("ClusterBuildDefaults — bootstrapped operator ETH fee funding", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("operator-funding-")
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
        ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
      },
      awsClusterNodeConfig: {
        account: AWSAccountName.dev,
        regions: ["us-east-1"],
        ssm: null
      }
    }
  }

  const fundingSteps = (names: string[]) => names.filter(name => name.endsWith(EthereumFundingStepSuffix))

  it("funds every bootstrapped operator's ETH wallet under SSM", async () => {
    const cluster = await ClusterBuildDefaults.create(ssmOptions())
    const funded = fundingSteps(collectStepNames(cluster.children))
    // Under SSM the operator EM keys come off a GENERATED mnemonic anvil never
    // funded, so an unfunded wallet cannot pay gas for its outbound deliveries
    // and the ETH outpost's envelope is never written (epoch stalls at 1).
    expect(funded.length).toBeGreaterThan(0)
    expect(funded).toContain(`${Constants.batchOperatorLabel(0)}${EthereumFundingStepSuffix}`)
  })

  it("funds the underwriters too, not just the batch operators", async () => {
    const cluster = await ClusterBuildDefaults.create(ssmOptions())
    const funded = fundingSteps(collectStepNames(cluster.children))
    expect(funded).toContain(`${Constants.underwriterLabel(0)}${EthereumFundingStepSuffix}`)
  })

  it("composes NO ETH funding under the default KEY provider", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    // KEY mode derives the EM keys from the anvil mnemonic, whose HD accounts
    // anvil prefunds — funding there would be redundant, and its absence is what
    // keeps every flow bootstrap byte-identical.
    expect(fundingSteps(collectStepNames(cluster.children))).toEqual([])
  })

  it("still airdrops SOL fees in BOTH modes — the ETH gate is ETH-only", async () => {
    const solanaAirdrops = (names: string[]) => names.filter(name => name.endsWith("-airdrop-solana"))
    const keyCluster = await ClusterBuildDefaults.create(baseOptions())
    const ssmCluster = await ClusterBuildDefaults.create(ssmOptions())
    expect(solanaAirdrops(collectStepNames(keyCluster.children)).length).toBeGreaterThan(0)
    expect(solanaAirdrops(collectStepNames(ssmCluster.children)).length).toBeGreaterThan(0)
  })
})
