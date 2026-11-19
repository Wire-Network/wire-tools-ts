import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Keypair } from "@solana/web3.js"
import { SlugName } from "@wireio/sdk-core"
import { TokenAmount } from "@wireio/opp-typescript-models"
import type { Argv } from "yargs"
import {
  AWSAccountName,
  BatchOperatorUnderwritingConfig,
  SignatureProviderType,
  type AWSClusterNodeConfig,
  type ClusterSignatureProviderOptions,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import {
  AWSClusterNodeConfigFlag,
  ClusterBuildOptionsFileFlag,
  SignatureProviderKMSFlag,
  SignatureProviderSSMFlag
} from "@wireio/cluster-tool/cli/ClusterBuildOptionsArgs"
import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import {
  createFundBatchOperatorsCommand,
  createTargets,
  loadExternalOutpostConfig,
  runFundBatchOperators,
  toFundBatchOperatorsOptions
} from "@wireio/cluster-tool/cli/FundBatchOperatorsCommand"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import type { ClusterBuildOptions } from "@wireio/cluster-tool/config"
import { BatchOperatorFundingTool } from "@wireio/cluster-tool/tools/all"
import { toURL } from "@wireio/cluster-tool/utils"

/** A captured `.option()` config — only the fields this suite asserts on. */
interface RecordedOption {
  type?: string
  demandOption?: boolean
  default?: unknown
  describe?: string
  choices?: readonly string[]
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
  return { argv: recorder as unknown as Argv, options }
}

const OppAddress = "0x1111111111111111111111111111111111111111"
const ChainId = 560_048
/** The finalized block the document was generated at — the Ethereum marker it carries. */
const AsOfBlock = 1_234_567
/** The finalized slot the document was generated at — the Solana marker it carries. */
const AsOfSlot = 345_678_901

/** The SSM custody settings every happy-path document carries. */
const SsmSignatureProvider: ClusterSignatureProviderOptions = {
  type: SignatureProviderType.SSM,
  ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" }
}
/** The AWS placement the SSM settings render their `{cluster}` segment from. */
const AwsClusterNodeConfig: AWSClusterNodeConfig = {
  account: AWSAccountName.dev,
  regions: ["us-east-1"],
  ssm: null,
  kms: null
}

describe("FundBatchOperatorsCommand", () => {
  let dir: string
  let ethereumRpcUrl: string
  let solanaRpcUrl: string
  const programId = Keypair.generate().publicKey.toBase58()

  /** An external outpost config carrying both as-of markers, with or without the endpoints. */
  function externalConfig(withEndpoints = true): ExternalOutpostConfig {
    return {
      ethereum: {
        chainId: ChainId,
        ...(withEndpoints ? { rpcUrl: ethereumRpcUrl } : {}),
        outpostAddresses: { OPP: OppAddress, OPPInbound: OppAddress, BAR: OppAddress },
        asOfBlock: AsOfBlock
      },
      solana: {
        ...(withEndpoints ? { rpcUrl: solanaRpcUrl } : {}),
        programId,
        asOfSlot: AsOfSlot
      }
    }
  }

  /** Write a JSON document into the sandbox and return its path. */
  function writeDocument(name: string, document: object): string {
    const file = Path.join(dir, name)
    Fs.writeFileSync(file, JSON.stringify(document))
    return file
  }

  /** The options a complete, fundable launch resolves to. */
  function fundableOptions(overrides: ClusterBuildOptions = {}): ClusterBuildOptions {
    return {
      batchOperatorCount: 3,
      enableBatchOperatorUnderwriting: true,
      ethereumPath: Path.join(dir, "wire-ethereum"),
      solanaPath: Path.join(dir, "wire-solana"),
      externalOutpostConfig: writeDocument("external-outpost-config.json", externalConfig()),
      signatureProvider: SsmSignatureProvider,
      awsClusterNodeConfig: AwsClusterNodeConfig,
      ...overrides
    }
  }

  beforeAll(async () => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "fund-batch-operators-"))
    ethereumRpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    )
    solanaRpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaRpc)
    )
  })

  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("registers the command under its enum member", () => {
    expect(createFundBatchOperatorsCommand().command).toBe(
      ClusterCommand["fund-batch-operators"]
    )
    expect(ClusterCommand["fund-batch-operators"]).toBe("fund-batch-operators")
  })

  it("registers EXACTLY the shared leaves it reads plus the four custody-document flags", () => {
    const recorder = createYargsRecorder()
    createFundBatchOperatorsCommand().builder(recorder.argv)
    expect([...recorder.options.keys()].sort()).toEqual(
      [
        "batch-operator-count",
        "enable-batch-operator-underwriting",
        "ethereum-path",
        "solana-path",
        "external-outpost-config",
        "signature-provider-type",
        SignatureProviderSSMFlag,
        SignatureProviderKMSFlag,
        ClusterBuildOptionsFileFlag,
        AWSClusterNodeConfigFlag
      ].sort()
    )
    // The outpost repo roots are demanded unless a document / env seeds them.
    expect(recorder.options.get("ethereum-path").demandOption).toBe(true)
    expect(recorder.options.get("solana-path").demandOption).toBe(true)
    expect(recorder.options.get("signature-provider-type").choices).toContain(
      SignatureProviderType.SSM
    )
  })

  it("seeds the shared leaves from the --cluster-build-options-file document", () => {
    const file = writeDocument("seed-options.json", {
        ethereumPath: "/repos/wire-ethereum",
        solanaPath: "/repos/wire-solana",
        enableBatchOperatorUnderwriting: true,
        batchOperatorCount: 9
      }),
      recorder = createYargsRecorder()
    createFundBatchOperatorsCommand([`--${ClusterBuildOptionsFileFlag}`, file]).builder(
      recorder.argv
    )
    expect(recorder.options.get("ethereum-path")).toMatchObject({
      default: "/repos/wire-ethereum",
      demandOption: false
    })
    expect(recorder.options.get("batch-operator-count").default).toBe(9)
    expect(recorder.options.get("enable-batch-operator-underwriting").default).toBe(true)
  })

  it("toFundBatchOperatorsOptions carries the document's flag-less batchOperatorUnderwriting + the custody merges", () => {
    const stake = [
        TokenAmount.create({ tokenCode: BigInt(SlugName.from(Constants.ETH_TOKEN_CODENAME)), amount: 5n }),
        TokenAmount.create({ tokenCode: BigInt(SlugName.from(Constants.SOL_TOKEN_CODENAME)), amount: 6n })
      ],
      nodeConfigFile = writeDocument("aws-cluster-node-config.json", {
        ...AwsClusterNodeConfig,
        ssm: SsmSignatureProvider.ssm
      }),
      options = toFundBatchOperatorsOptions(
        {
          "batch-operator-count": 3,
          "enable-batch-operator-underwriting": true,
          "signature-provider-type": SignatureProviderType.SSM,
          [AWSClusterNodeConfigFlag]: nodeConfigFile
        },
        { batchOperatorUnderwriting: { fundedOperatorCount: 2, stake } }
      )
    expect(options.batchOperatorUnderwriting).toEqual({ fundedOperatorCount: 2, stake })
    expect(options.signatureProvider.type).toBe(SignatureProviderType.SSM)
    expect(options.signatureProvider.ssm).toEqual(SsmSignatureProvider.ssm)
    expect(options.awsClusterNodeConfig.account).toBe(AWSAccountName.dev)
  })

  it("loadExternalOutpostConfig decodes a document and refuses a malformed one", () => {
    expect(
      loadExternalOutpostConfig(writeDocument("external.json", externalConfig())).solana
        .programId
    ).toBe(programId)
    expect(() =>
      loadExternalOutpostConfig(writeDocument("broken.json", { ethereum: {} }))
    ).toThrow()
  })

  it("createTargets composes both targets from the config — the as-of markers included — and refuses a missing endpoint", () => {
    const targets = createTargets(externalConfig(), "/repos/wire-ethereum", "/repos/wire-solana")
    expect(targets.ethereum.chainId).toBe(ChainId)
    expect(targets.ethereum.ethereumPath).toBe("/repos/wire-ethereum")
    expect(targets.ethereum.outpostAddresses.OPP).toBe(OppAddress)
    expect(targets.ethereum.asOfBlock).toBe(AsOfBlock)
    expect(targets.solana.programId.toBase58()).toBe(programId)
    expect(targets.solana.solanaPath).toBe("/repos/wire-solana")
    expect(targets.solana.connection.rpcEndpoint).toBe(solanaRpcUrl)
    expect(targets.solana.asOfSlot).toBe(AsOfSlot)
    expect(() =>
      createTargets(externalConfig(false), "/repos/wire-ethereum", "/repos/wire-solana")
    ).toThrow(/must carry ethereum\.rpcUrl/)
  })

  describe("runFundBatchOperators", () => {
    it("refuses a run without the external outpost config, before touching any key", async () => {
      const fund = jest.spyOn(BatchOperatorFundingTool, "fund")
      await expect(
        runFundBatchOperators(fundableOptions({ externalOutpostConfig: undefined }))
      ).rejects.toThrow(/requires --external-outpost-config/)
      expect(fund).not.toHaveBeenCalled()
    })

    it("refuses a document that does not enable batch-operator underwriting", async () => {
      await expect(
        runFundBatchOperators(
          fundableOptions({ enableBatchOperatorUnderwriting: false })
        )
      ).rejects.toThrow(/do not enable batch-operator underwriting/)
    })

    it("refuses a funded-operator count of zero", async () => {
      await expect(
        runFundBatchOperators(
          fundableOptions({ batchOperatorUnderwriting: { fundedOperatorCount: 0 } })
        )
      ).rejects.toThrow(/fundedOperatorCount is 0 — no operator to fund/)
    })

    it("refuses a KEY provider — there is no custody store to adopt from", async () => {
      const fund = jest.spyOn(BatchOperatorFundingTool, "fund")
      await expect(
        runFundBatchOperators(
          fundableOptions({
            signatureProvider: { type: SignatureProviderType.KEY },
            awsClusterNodeConfig: undefined
          })
        )
      ).rejects.toThrow(/requires an SSM signature provider \(got KEY\)/)
      expect(fund).not.toHaveBeenCalled()
    })

    it("adopts the first fundedOperatorCount operators and funds them with the document's stake + the default reserve", async () => {
      const stake = [
          TokenAmount.create({ tokenCode: BigInt(SlugName.from(Constants.ETH_TOKEN_CODENAME)), amount: 5n }),
          TokenAmount.create({ tokenCode: BigInt(SlugName.from(Constants.SOL_TOKEN_CODENAME)), amount: 6n })
        ],
        operators = [{ label: "batchop.a" }, { label: "batchop.b" }] as never,
        outcome: BatchOperatorFundingTool.Outcome = { receipts: [], skips: [] },
        adopt = jest
          .spyOn(BatchOperatorFundingTool, "adoptOperators")
          .mockResolvedValue(operators),
        fund = jest.spyOn(BatchOperatorFundingTool, "fund").mockResolvedValue(outcome)
      await expect(
        runFundBatchOperators(
          fundableOptions({
            batchOperatorUnderwriting: { fundedOperatorCount: 2, stake }
          })
        )
      ).resolves.toBe(outcome)
      expect(adopt).toHaveBeenCalledTimes(1)
      const [settings, labels] = adopt.mock.calls[0]
      expect(settings.signatureProvider.type).toBe(SignatureProviderType.SSM)
      expect(settings.awsClusterNodeConfig.account).toBe(AWSAccountName.dev)
      expect(labels).toEqual(["batchop.a", "batchop.b"])
      const [funded, allocation, targets] = fund.mock.calls[0]
      expect(funded).toBe(operators)
      expect(allocation.stake).toBe(stake)
      expect(allocation.reserve).toEqual(BatchOperatorUnderwritingConfig.DefaultReserve)
      expect(targets.ethereum.chainId).toBe(ChainId)
      expect(targets.solana.programId.toBase58()).toBe(programId)
    })

    it("funds every operator with both defaults when the document sets neither amount", async () => {
      jest.spyOn(BatchOperatorFundingTool, "adoptOperators").mockResolvedValue([])
      const fund = jest
        .spyOn(BatchOperatorFundingTool, "fund")
        .mockResolvedValue({ receipts: [], skips: [] })
      await runFundBatchOperators(fundableOptions())
      const [, allocation] = fund.mock.calls[0],
        [, labels] = (BatchOperatorFundingTool.adoptOperators as jest.Mock).mock.calls[0]
      expect(labels).toEqual(["batchop.a", "batchop.b", "batchop.c"])
      expect(allocation.stake).toEqual(BatchOperatorUnderwritingConfig.DefaultStake)
      expect(allocation.reserve).toEqual(BatchOperatorUnderwritingConfig.DefaultReserve)
    })
  })

  describe("handler", () => {
    let exitSpy: jest.SpiedFunction<typeof process.exit>

    beforeEach(() => {
      exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never)
    })

    /**
     * Run the handler over a complete, fundable launch — every input by flag,
     * as yargs hands them over after applying a document's defaults, the SSM
     * custody from the node-config file — with the adoption + funding stubbed
     * to `outcome`.
     */
    async function runHandler(outcome: BatchOperatorFundingTool.Outcome): Promise<void> {
      jest.spyOn(BatchOperatorFundingTool, "adoptOperators").mockResolvedValue([])
      jest.spyOn(BatchOperatorFundingTool, "fund").mockResolvedValue(outcome)
      const {
          batchOperatorCount,
          enableBatchOperatorUnderwriting,
          ethereumPath,
          solanaPath,
          externalOutpostConfig
        } = fundableOptions(),
        nodeConfigFile = writeDocument("handler-node-config.json", {
          ...AwsClusterNodeConfig,
          ssm: SsmSignatureProvider.ssm
        })
      await createFundBatchOperatorsCommand().handler({
        "batch-operator-count": batchOperatorCount,
        "enable-batch-operator-underwriting": enableBatchOperatorUnderwriting,
        "ethereum-path": ethereumPath,
        "solana-path": solanaPath,
        "external-outpost-config": externalOutpostConfig,
        "signature-provider-type": SignatureProviderType.SSM,
        [AWSClusterNodeConfigFlag]: nodeConfigFile
      })
    }

    it("exits 0 when every leg landed or was skipped for an existing position", async () => {
      await runHandler({
        receipts: [],
        skips: [
          {
            label: "batchop.a",
            chain: Constants.ETHEREUM_CHAIN_CODENAME,
            reason: BatchOperatorFundingTool.SkipReason.existingPosition,
            amount: 1n
          }
        ]
      })
      expect(BatchOperatorFundingTool.fund).toHaveBeenCalledTimes(1)
      expect(exitSpy.mock.calls[0]).toEqual([0])
    })

    it("exits 1 when a write failed, after printing what landed", async () => {
      await runHandler({
        receipts: [],
        skips: [],
        failure: {
          label: "batchop.a",
          chain: Constants.SOLANA_CHAIN_CODENAME,
          error: new Error("custom program error: 0x1dc5")
        }
      })
      expect(exitSpy.mock.calls[0]).toEqual([1])
    })
  })
})
