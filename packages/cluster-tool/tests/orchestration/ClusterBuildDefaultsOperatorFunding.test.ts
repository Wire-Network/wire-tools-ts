import Path from "node:path"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import {
  AWSAccountName,
  SignatureProviderType
} from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import type { ClusterBuildOptions } from "@wireio/cluster-tool/config"
import {
  ClusterBuildDefaults,
  type StepInput
} from "@wireio/cluster-tool/orchestration"
import { WireOperatorProvisioningTool } from "@wireio/cluster-tool/tools/wire"
import {
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectStepNames, findPhase } from "./clusterBuildFixture.js"

const mockSend = jest.fn()
// An SSM cluster ADOPTS its genesis keys during config resolution, so even a
// composition-only suite performs that read — answer it locally rather than
// reaching for real AWS credentials (same rationale as the key-publication suite).
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "GetParameter", input })),
  PutParameterCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ kind: "PutParameter", input }))
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
/** Steps that airdrop an operator's SOL keypair, by the factory's name suffix. */
const SolanaAirdropStepSuffix = "-airdrop-solana"
/** The provisioning phase of one bootstrapped operator. */
const provisionPhaseName = (label: string) => `Provision ${label}`

/** The deterministic dev private key, chain-native, for the curve `secretId` names. */
function publishedKey(secretId: string): string {
  const keyType = secretId.slice(secretId.lastIndexOf("/") + 1)
  return PrivateKey.from(
    keyType === KeyType[KeyType.BLS]
      ? Constants.DEV_BLS_PRIVATE_KEY
      : Constants.DEV_K1_PRIVATE_KEY
  ).toNativeString()
}

describe("ClusterBuildDefaults — bootstrapped operator fee funding on BOTH outposts", () => {
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

  function ssmOptions(): ClusterBuildOptions {
    return {
      ...baseOptions(),
      signatureProvider: {
        type: SignatureProviderType.SSM,
        ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
      },
      awsClusterNodeConfig: {
        account: AWSAccountName.dev,
        regions: ["us-east-1"],
        ssm: null,
        kms: null
      }
    }
  }

  const fundingSteps = (names: string[]) =>
    names.filter(name => name.endsWith(EthereumFundingStepSuffix))
  const solanaAirdrops = (names: string[]) =>
    names.filter(name => name.endsWith(SolanaAirdropStepSuffix))

  it.each([
    ["KEY", () => baseOptions()],
    ["SSM", () => ssmOptions()]
  ])(
    "funds EVERY bootstrapped batch operator's ETH wallet under %s — each EM key is random and starts at zero on the run anvil",
    async (_provider, options) => {
      const cluster = await ClusterBuildDefaults.create(options()),
        labels = Constants.batchOperatorLabels(
          cluster.context.config.batchOperatorCount
        )
      expect(labels.length).toBeGreaterThan(0)
      expect(fundingSteps(collectStepNames(cluster.children))).toEqual(
        labels.map(label => `${label}${EthereumFundingStepSuffix}`)
      )
    }
  )

  it("funds each operator the SAME positive fee-payer amount, after its account exists and before its links", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      labels = Constants.batchOperatorLabels(
        cluster.context.config.batchOperatorCount
      ),
      amounts = labels.map(label => {
        const phase = findPhase(cluster.children, provisionPhaseName(label)),
          kinds = phase.steps.map(step => (step.input as StepInput).kind),
          funding = phase.steps.find(
            step => step.name === `${label}${EthereumFundingStepSuffix}`
          )
        expect(
          kinds.indexOf("WireOperatorProvisioningTool.FundEthereumInput")
        ).toBeGreaterThan(
          kinds.indexOf("WireOperatorProvisioningTool.CreateAccountInput")
        )
        expect(
          kinds.indexOf("WireOperatorProvisioningTool.FundEthereumInput")
        ).toBeLessThan(
          kinds.indexOf("WireOperatorProvisioningTool.AuthexLinkInput")
        )
        expect(funding.runner).toBe(
          WireOperatorProvisioningTool.runEthereumFunding
        )
        return (funding.input as WireOperatorProvisioningTool.FundEthereumInput)
          .wei
      })
    expect(new Set(amounts).size).toBe(1)
    expect(amounts[0]).toBeGreaterThan(0n)
  })

  it("airdrops SOL fees in BOTH modes too — the two faucets are planned together", async () => {
    const keyCluster = await ClusterBuildDefaults.create(baseOptions()),
      ssmCluster = await ClusterBuildDefaults.create(ssmOptions())
    ;[keyCluster, ssmCluster].forEach(cluster => {
      const names = collectStepNames(cluster.children)
      expect(solanaAirdrops(names).length).toBeGreaterThan(0)
      expect(solanaAirdrops(names).length).toBe(fundingSteps(names).length)
    })
  })

  it("composes NO outpost-chain funding in external-outpost mode — operators are pre-funded on the real chains", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        externalOutpostConfig: fixtureExternalOutpostConfig(environment.rootPath)
      }),
      names = collectStepNames(cluster.children)
    expect(fundingSteps(names)).toEqual([])
    expect(solanaAirdrops(names)).toEqual([])
    // The depot-side provisioning still runs for every operator.
    expect(
      names.filter(name => name.endsWith("-register")).length
    ).toBeGreaterThan(0)
  })
})
