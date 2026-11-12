import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { Keypair, PublicKey, type Connection } from "@solana/web3.js"
import { KeyType, SlugName } from "@wireio/sdk-core"
import { OperatorType, TokenAmount } from "@wireio/opp-typescript-models"
import {
  AWSAccountName,
  BatchOperatorUnderwritingConfig,
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type KeyCustodySettings
} from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import type { OperatorAccount } from "@wireio/cluster-tool/orchestration/outputs"
import type { SolanaSigner } from "@wireio/cluster-tool/types"
import { KeySteps } from "@wireio/cluster-tool/orchestration/steps/KeySteps"
import { BatchOperatorFundingTool } from "@wireio/cluster-tool/tools/all"
import {
  EthereumPreLaunchStakingTool,
  EthereumSyndicationTool,
  type EthereumOutpostTarget
} from "@wireio/cluster-tool/tools/ethereum"
import {
  SolanaLiqSyndicationTool,
  SolanaOutpostProgramTool,
  WireState,
  type SolanaOutpostTarget
} from "@wireio/cluster-tool/tools/solana"
import * as keyPairUtils from "@wireio/cluster-tool/utils/keyPairUtils"

const DepositorAddress = "0x1111111111111111111111111111111111111111"
const PoolAddress = "0x2222222222222222222222222222222222222222"
const DepositManagerAddress = "0x3333333333333333333333333333333333333333"
const LiqEthAddress = "0x4444444444444444444444444444444444444444"
const ChainId = 31_337
/** The epoch-rewards window is never open in these cases. */
const SolanaMaxSyndication = 1_000_000_000_000n
const EthereumMaxSyndication = 1_000_000_000_000_000_000_000n

/** The part of a hardhat artifact these cases bind: its ABI. */
interface AbiArtifact {
  abi: ethers.InterfaceAbi
}

/** A hardhat-shaped artifact from a committed fixture. */
function fixture(name: string): AbiArtifact {
  return JSON.parse(
    Fs.readFileSync(Path.join(__dirname, "..", "..", "fixtures", name), "utf8")
  )
}

/** Write `artifact` where `loadOutpostContract` reads it. */
function stageArtifact(
  ethereumPath: string,
  subpath: readonly string[],
  sourceName: string,
  contractName: string,
  artifact: object
): void {
  const dir = Path.join(
    ethereumPath,
    "artifacts",
    "contracts",
    ...subpath,
    `${sourceName}.sol`
  )
  Fs.mkdirSync(dir, { recursive: true })
  Fs.writeFileSync(Path.join(dir, `${contractName}.json`), JSON.stringify(artifact))
}

/** A native amount in depot units. */
const native = (codename: string, amount: bigint): TokenAmount =>
  TokenAmount.create({ tokenCode: BigInt(SlugName.from(codename)), amount })

/** 1 ETH + 10 SOL staked, 0.05 ETH + 0.1 SOL kept — the defaults, spelled as an allocation. */
const DefaultAllocation: BatchOperatorFundingTool.Allocation = {
  stake: BatchOperatorUnderwritingConfig.DefaultStake,
  reserve: BatchOperatorUnderwritingConfig.DefaultReserve
}

/** A fake Ethereum provider's answers, keyed `<address>:<function>`. */
type ProviderAnswers = Record<string, ReadonlyArray<unknown>>

/** The fake signer a case inspects. */
interface FakeSigner {
  sendTransaction: jest.Mock
}

describe("BatchOperatorFundingTool", () => {
  let root: string
  let ethereumPath: string
  let solanaPath: string
  const interfaces = {
    staking: new ethers.Interface(fixture("depositorV3.abi.json").abi),
    pool: new ethers.Interface(fixture("syndicationPool.abi.json").abi),
    depositManager: new ethers.Interface(fixture("depositManager.abi.json").abi),
    liqEth: new ethers.Interface(fixture("liqEthToken.abi.json").abi)
  }

  /** Every operator key pair a case needs, generated in-process. */
  async function operator(label: string): Promise<OperatorAccount> {
    const context = KeyGenerator.context()
    return {
      label,
      publicationLabel: label,
      account: label,
      type: OperatorType.BATCH,
      wire: await KeyGenerator.create(KeyType.K1, context),
      ethereum: await KeyGenerator.create(KeyType.EM, context),
      solana: await KeyGenerator.create(KeyType.ED, context)
    }
  }

  /**
   * A provider answering `getNetwork` / `getBalance` / `getTransactionCount`
   * and each contract view from `answers` — what every Ethereum read and the
   * nonce seed go through.
   */
  function fakeProvider(
    balances: Record<string, bigint>,
    answers: ProviderAnswers,
    chainId: number = ChainId
  ): ethers.Provider {
    return {
      getNetwork: async () => ({ chainId: BigInt(chainId) }),
      getBalance: async (address: string) => balances[address.toLowerCase()] ?? 0n,
      getTransactionCount: async () => 0,
      call: async (transaction: ethers.TransactionRequest) => {
        const selector = String(transaction.data).slice(0, 10),
          iface = Object.values(interfaces).find(
            candidate => candidate.getFunction(selector) != null
          ),
          fragment = iface.getFunction(selector),
          answer = answers[`${String(transaction.to).toLowerCase()}:${fragment.name}`]
        expect(answer).toBeDefined()
        return iface.encodeFunctionResult(fragment, answer)
      }
    } as unknown as ethers.Provider
  }

  /** A pre-launch target: the staking proxy recorded, no liqEth book. */
  function preLaunchTarget(provider: ethers.Provider): EthereumOutpostTarget {
    return {
      provider,
      ethereumPath,
      chainId: ChainId,
      outpostAddresses: {
        [EthereumPreLaunchStakingTool.StakingContractName]: DepositorAddress,
        [EthereumSyndicationTool.SyndicationPoolContractName]: PoolAddress
      },
      liqEthAddresses: {
        [EthereumSyndicationTool.DepositManagerContractName]: DepositManagerAddress,
        [EthereumSyndicationTool.LiqEthTokenContractName]: LiqEthAddress
      }
    }
  }

  /** A post-launch target: no staking proxy in the book at all. */
  function postLaunchTarget(provider: ethers.Provider): EthereumOutpostTarget {
    const { outpostAddresses, ...rest } = preLaunchTarget(provider),
      { [EthereumPreLaunchStakingTool.StakingContractName]: _staking, ...book } =
        outpostAddresses
    return { ...rest, outpostAddresses: book }
  }

  /** A Solana target whose connection answers `getBalance` with `lamports`. */
  function solanaTarget(lamports: bigint): SolanaOutpostTarget {
    return {
      connection: {
        getBalance: async () => Number(lamports)
      } as unknown as Connection,
      solanaPath,
      programId: Keypair.generate().publicKey
    }
  }

  /** The pre-launch gate answers of a staking proxy. */
  function stakingAnswers(
    gate: Partial<EthereumPreLaunchStakingTool.LaunchGate> = {}
  ): ProviderAnswers {
    const { dDay = false, refundActive = false, paused = false } = gate
    return {
      [`${DepositorAddress}:dDay`]: [dDay],
      [`${DepositorAddress}:isRefundActive`]: [refundActive],
      [`${DepositorAddress}:paused`]: [paused]
    }
  }

  /** The post-launch pool + liqETH answers. */
  function poolAnswers(minted: bigint, paused = false): ProviderAnswers {
    return {
      [`${PoolAddress}:paused`]: [paused],
      [`${PoolAddress}:maxSyndicationPerTransfer`]: [EthereumMaxSyndication],
      [`${PoolAddress}:yieldDeadband`]: [1n],
      [`${PoolAddress}:liqTokenCode`]: [1n],
      [`${PoolAddress}:liqTokenPrecision`]: [18n],
      [`${LiqEthAddress}:balanceOf`]: [minted]
    }
  }

  /** The Solana reads every funding case stubs — a fundable outpost in `wireState`. */
  function stubSolanaReads(wireState: WireState): void {
    jest.spyOn(SolanaLiqSyndicationTool, "readWireState").mockResolvedValue(wireState)
    jest.spyOn(SolanaLiqSyndicationTool, "readGlobalStateFrozen").mockResolvedValue(false)
    jest.spyOn(SolanaLiqSyndicationTool, "readGlobalStatePaused").mockResolvedValue(false)
    jest.spyOn(SolanaLiqSyndicationTool, "readGlobalConfig").mockResolvedValue({
      admin: PublicKey.default,
      panic: PublicKey.default,
      maxSyndicationPerTransfer: SolanaMaxSyndication
    })
  }

  /** The Solana writes, stubbed: the builders return markers, `submit` returns signatures in order. */
  function stubSolanaWrites(minted: bigint): jest.SpyInstance {
    jest.spyOn(SolanaLiqSyndicationTool, "waitForEpochRewardsIdle").mockResolvedValue()
    jest
      .spyOn(SolanaLiqSyndicationTool, "submitWithEpochRewardsRetry")
      .mockImplementation((_source, _label, send) => send())
    jest
      .spyOn(SolanaLiqSyndicationTool, "depositForLiqsolTransaction")
      .mockResolvedValue({ kind: "deposit" } as never)
    jest
      .spyOn(SolanaLiqSyndicationTool, "syndTransaction")
      .mockResolvedValue({ kind: "synd" } as never)
    jest.spyOn(SolanaLiqSyndicationTool, "readLiqsolBalanceOf").mockResolvedValue(minted)
    let sent = 0
    return jest
      .spyOn(SolanaLiqSyndicationTool, "submit")
      .mockImplementation(async () => `solana-signature-${(sent += 1)}`)
  }

  /** A signer double whose every send mines with `status`, hashed in order. */
  function fakeSigner(
    account: OperatorAccount,
    provider: ethers.Provider,
    status = 1
  ): FakeSigner {
    let sent = 0
    const sendTransaction = jest.fn(async (_request: ethers.TransactionRequest) => ({
        wait: async () => ({ status, hash: `0xethereum-${(sent += 1)}` })
      })),
      signer = {
        provider,
        getAddress: async () => account.ethereum.address,
        sendTransaction
      } as unknown as ethers.Signer
    jest.spyOn(keyPairUtils, "ethereumSigner").mockResolvedValue(signer)
    return { sendTransaction }
  }

  beforeAll(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "batch-operator-funding-"))
    ethereumPath = Path.join(root, "wire-ethereum")
    solanaPath = Path.join(root, "wire-solana")
    stageArtifact(
      ethereumPath,
      EthereumPreLaunchStakingTool.StakingArtifactSubpath,
      EthereumPreLaunchStakingTool.StakingContractName,
      EthereumPreLaunchStakingTool.StakingArtifactContractName,
      fixture("depositorV3.abi.json")
    )
    stageArtifact(
      ethereumPath,
      EthereumSyndicationTool.SyndicationPoolArtifactSubpath,
      EthereumSyndicationTool.SyndicationPoolContractName,
      EthereumSyndicationTool.SyndicationPoolContractName,
      fixture("syndicationPool.abi.json")
    )
    stageArtifact(
      ethereumPath,
      EthereumSyndicationTool.DepositManagerArtifactSubpath,
      EthereumSyndicationTool.DepositManagerContractName,
      EthereumSyndicationTool.DepositManagerContractName,
      fixture("depositManager.abi.json")
    )
    stageArtifact(
      ethereumPath,
      EthereumSyndicationTool.LiqEthTokenArtifactSubpath,
      EthereumSyndicationTool.LiqEthTokenSourceName,
      EthereumSyndicationTool.LiqEthTokenContractName,
      fixture("liqEthToken.abi.json")
    )
    Fs.mkdirSync(
      Path.join(solanaPath, SolanaOutpostProgramTool.KeysSubdirectory),
      { recursive: true }
    )
    SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach(name =>
      Fs.writeFileSync(
        SolanaOutpostProgramTool.programKeypairFile(solanaPath, name),
        JSON.stringify([...Keypair.generate().secretKey])
      )
    )
  })

  afterAll(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe("enums + amounts", () => {
    it("FundingAction / EthereumLaunchPhase are identity enums", () => {
      Object.entries(BatchOperatorFundingTool.FundingAction).forEach(([key, value]) =>
        expect(value).toBe(key)
      )
      Object.entries(BatchOperatorFundingTool.EthereumLaunchPhase).forEach(
        ([key, value]) => expect(value).toBe(key)
      )
    })

    it("converts depot units to wei (×10^9) and lamports (×1)", () => {
      expect(BatchOperatorFundingTool.WeiPerDepotUnit).toBe(1_000_000_000n)
      expect(BatchOperatorFundingTool.LamportsPerDepotUnit).toBe(1n)
      expect(BatchOperatorFundingTool.nativeUnits(3n, BatchOperatorFundingTool.WeiPerDepotUnit)).toBe(
        3_000_000_000n
      )
      expect(BatchOperatorFundingTool.nativeAllocation(DefaultAllocation)).toEqual({
        stakeWei: ethers.WeiPerEther,
        reserveWei: ethers.WeiPerEther / 20n,
        stakeLamports: 10_000_000_000n,
        reserveLamports: 100_000_000n
      })
    })

    it("amountFor finds a token's amount and refuses a missing one", () => {
      expect(
        BatchOperatorFundingTool.amountFor(DefaultAllocation.stake, Constants.SOL_TOKEN_CODENAME)
      ).toBe(BatchOperatorUnderwritingConfig.DefaultStakeSolanaUnits)
      expect(() =>
        BatchOperatorFundingTool.amountFor(
          [native(Constants.ETH_TOKEN_CODENAME, 1n)],
          Constants.SOL_TOKEN_CODENAME
        )
      ).toThrow(/no amount is configured for SOL \(configured: ETH\)/)
    })

    it("toListingJson renders bigint amounts as decimal strings", () => {
      const listing = BatchOperatorFundingTool.toListingJson([
        {
          label: "batchop.a",
          chain: Constants.ETHEREUM_CHAIN_CODENAME,
          action: BatchOperatorFundingTool.FundingAction.depositAndStake,
          transaction: "0xabc",
          amount: 1_000_000_000_000_000_000n
        }
      ])
      expect(JSON.parse(listing)).toEqual([
        {
          label: "batchop.a",
          chain: "ETHEREUM",
          action: "depositAndStake",
          transaction: "0xabc",
          amount: "1000000000000000000"
        }
      ])
      expect(listing.startsWith("[\n  {")).toBe(true)
    })
  })

  describe("adoptOperators", () => {
    const settings: KeyCustodySettings = {
      signatureProvider: {
        type: SignatureProviderType.SSM,
        ssm: { awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}" },
        kms: null,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOrCreate
      },
      awsClusterNodeConfig: {
        account: AWSAccountName.dev,
        regions: ["us-east-1"],
        ssm: null,
        kms: null
      }
    }

    it("adopts every curve under the adopt-only policy and assembles the identities", async () => {
      const pairs = await operator("batchop.a"),
        adopt = jest
          .spyOn(KeySteps, "adoptOrCreateSignatureProviderKey")
          .mockImplementation(async (adopting, keyType) => {
            expect(adopting.signatureProvider.batchOperatorKeyPolicy).toBe(
              SignatureProviderKeyPolicy.adoptOnly
            )
            return keyType === KeyType.K1
              ? pairs.wire
              : keyType === KeyType.EM
                ? pairs.ethereum
                : pairs.solana
          }),
        [adopted] = await BatchOperatorFundingTool.adoptOperators(
          settings,
          ["batchop.a"],
          KeyGenerator.context()
        )
      expect(adopt).toHaveBeenCalledTimes(3)
      expect(adopted).toEqual({
        label: "batchop.a",
        publicationLabel: "batchop.a",
        account: "batchop.a",
        type: OperatorType.BATCH,
        wire: pairs.wire,
        ethereum: pairs.ethereum,
        solana: pairs.solana
      })
    })

    it("propagates a missing key (the adopt-only refusal) instead of creating one", async () => {
      jest
        .spyOn(KeySteps, "adoptOrCreateSignatureProviderKey")
        .mockRejectedValue(new Error("no existing EM key was found for batch operator batchop.a"))
      await expect(
        BatchOperatorFundingTool.adoptOperators(settings, ["batchop.a"], KeyGenerator.context())
      ).rejects.toThrow(/no existing EM key/)
    })

    it("refuses a KEY provider and a non-batch-operator label", async () => {
      await expect(
        BatchOperatorFundingTool.adoptOperators(
          {
            ...settings,
            signatureProvider: { ...settings.signatureProvider, type: SignatureProviderType.KEY, ssm: null }
          },
          ["batchop.a"],
          KeyGenerator.context()
        )
      ).rejects.toThrow(/requires an SSM signature provider \(got KEY\)/)
      await expect(
        BatchOperatorFundingTool.adoptOperators(settings, ["uwrit.a"], KeyGenerator.context())
      ).rejects.toThrow(/"uwrit.a" is not a bootstrap batch-operator label/)
    })
  })

  describe("resolveEthereumLaunchPhase", () => {
    it("is post-launch without a staking proxy, or once D-Day is set", async () => {
      await expect(
        BatchOperatorFundingTool.resolveEthereumLaunchPhase(
          postLaunchTarget(fakeProvider({}, {}))
        )
      ).resolves.toBe(BatchOperatorFundingTool.EthereumLaunchPhase.postLaunch)
      await expect(
        BatchOperatorFundingTool.resolveEthereumLaunchPhase(
          preLaunchTarget(fakeProvider({}, stakingAnswers({ dDay: true })))
        )
      ).resolves.toBe(BatchOperatorFundingTool.EthereumLaunchPhase.postLaunch)
    })

    it("is pre-launch while the proxy is live, refusing a refund window or a pause", async () => {
      await expect(
        BatchOperatorFundingTool.resolveEthereumLaunchPhase(
          preLaunchTarget(fakeProvider({}, stakingAnswers()))
        )
      ).resolves.toBe(BatchOperatorFundingTool.EthereumLaunchPhase.preLaunch)
      await expect(
        BatchOperatorFundingTool.resolveEthereumLaunchPhase(
          preLaunchTarget(fakeProvider({}, stakingAnswers({ refundActive: true })))
        )
      ).rejects.toThrow(/refund window is open/)
      await expect(
        BatchOperatorFundingTool.resolveEthereumLaunchPhase(
          preLaunchTarget(fakeProvider({}, stakingAnswers({ paused: true })))
        )
      ).rejects.toThrow(/is paused/)
    })
  })

  describe("resolveWireState", () => {
    it("accepts PreLaunch and PostLaunch", async () => {
      stubSolanaReads(WireState.preLaunch)
      await expect(
        BatchOperatorFundingTool.resolveWireState(solanaTarget(0n))
      ).resolves.toBe(WireState.preLaunch)
      jest.restoreAllMocks()
      stubSolanaReads(WireState.postLaunch)
      await expect(
        BatchOperatorFundingTool.resolveWireState(solanaTarget(0n))
      ).resolves.toBe(WireState.postLaunch)
    })

    it("refuses Launching, Refund, a frozen outpost and a paused surface", async () => {
      stubSolanaReads(WireState.launching)
      await expect(
        BatchOperatorFundingTool.resolveWireState(solanaTarget(0n))
      ).rejects.toThrow(/is launching — the frozen snapshot window refuses every synd/)
      jest.restoreAllMocks()
      stubSolanaReads(WireState.refund)
      await expect(
        BatchOperatorFundingTool.resolveWireState(solanaTarget(0n))
      ).rejects.toThrow(/is in refund/)
      jest.restoreAllMocks()
      stubSolanaReads(WireState.preLaunch)
      jest.spyOn(SolanaLiqSyndicationTool, "readGlobalStateFrozen").mockResolvedValue(true)
      await expect(
        BatchOperatorFundingTool.resolveWireState(solanaTarget(0n))
      ).rejects.toThrow(/is frozen \(emergency stop\)/)
      jest.restoreAllMocks()
      stubSolanaReads(WireState.preLaunch)
      jest.spyOn(SolanaLiqSyndicationTool, "readGlobalStatePaused").mockResolvedValue(true)
      await expect(
        BatchOperatorFundingTool.resolveWireState(solanaTarget(0n))
      ).rejects.toThrow(/surface is paused/)
    })
  })

  describe("assertFundable", () => {
    it("refuses an operator whose balance is below stake + reserve, on either outpost", async () => {
      const account = await operator("batchop.a")
      stubSolanaReads(WireState.preLaunch)
      await expect(
        BatchOperatorFundingTool.assertFundable([account], DefaultAllocation, {
          ethereum: preLaunchTarget(
            fakeProvider({ [account.ethereum.address.toLowerCase()]: ethers.WeiPerEther }, stakingAnswers())
          ),
          solana: solanaTarget(20_000_000_000n)
        })
      ).rejects.toThrow(/batchop\.a's Ethereum balance 1000000000000000000 wei .* is below stake \+ reserve 1050000000000000000 wei/)
      await expect(
        BatchOperatorFundingTool.assertFundable([account], DefaultAllocation, {
          ethereum: preLaunchTarget(
            fakeProvider({ [account.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther }, stakingAnswers())
          ),
          solana: solanaTarget(10_000_000_000n)
        })
      ).rejects.toThrow(/batchop\.a's Solana balance 10000000000 lamports .* is below stake \+ reserve 10100000000 lamports/)
    })

    it("refuses a wrong chain behind the endpoint, before any other read", async () => {
      const account = await operator("batchop.a")
      await expect(
        BatchOperatorFundingTool.assertFundable([account], DefaultAllocation, {
          ethereum: preLaunchTarget(fakeProvider({}, {}, 1)),
          solana: solanaTarget(0n)
        })
      ).rejects.toThrow(/fronts chain 1, not the configured 31337/)
    })

    it("refuses a Solana per-transfer maximum below the stake, and a LIQSOL mint the build does not derive", async () => {
      const account = await operator("batchop.a"),
        ethereum = preLaunchTarget(
          fakeProvider({ [account.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther }, stakingAnswers())
        )
      stubSolanaReads(WireState.preLaunch)
      jest.spyOn(SolanaLiqSyndicationTool, "readGlobalConfig").mockResolvedValue({
        admin: PublicKey.default,
        panic: PublicKey.default,
        maxSyndicationPerTransfer: 1n
      })
      await expect(
        BatchOperatorFundingTool.assertFundable([account], DefaultAllocation, {
          ethereum,
          solana: solanaTarget(20_000_000_000n)
        })
      ).rejects.toThrow(/stake 10000000000 lamports exceeds global_config.max_syndication_per_transfer 1/)
      const foreignMint = Keypair.generate().publicKey.toBase58()
      await expect(
        BatchOperatorFundingTool.assertFundable([account], DefaultAllocation, {
          ethereum,
          solana: {
            ...solanaTarget(20_000_000_000n),
            mints: [
              { code: Number(SlugName.from(Constants.LIQSOL_CODENAME)), mint: foreignMint, decimals: 9 }
            ]
          }
        })
      ).rejects.toThrow(/LIQSOL mint .* is not the liqsol-token mint the wire-solana build derives/)
    })

    it("refuses an empty roster", async () => {
      await expect(
        BatchOperatorFundingTool.assertFundable([], DefaultAllocation, {
          ethereum: preLaunchTarget(fakeProvider({}, {})),
          solana: solanaTarget(0n)
        })
      ).rejects.toThrow(/no operator to fund/)
    })
  })

  describe("fund", () => {
    it("pre-launch: one depositAndStake, then sol_to_liqsol + synd in the PreLaunch form", async () => {
      const account = await operator("batchop.a"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther },
          stakingAnswers()
        ),
        { sendTransaction } = fakeSigner(account, provider),
        minted = 10_000_000_000n
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(minted),
        solana = solanaTarget(20_000_000_000n),
        outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(provider),
          solana
        })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.receipts).toEqual([
        {
          label: "batchop.a",
          chain: Constants.ETHEREUM_CHAIN_CODENAME,
          action: BatchOperatorFundingTool.FundingAction.depositAndStake,
          transaction: "0xethereum-1",
          amount: ethers.WeiPerEther
        },
        {
          label: "batchop.a",
          chain: Constants.SOLANA_CHAIN_CODENAME,
          action: BatchOperatorFundingTool.FundingAction.solToLiqsol,
          transaction: "solana-signature-1",
          amount: 10_000_000_000n
        },
        {
          label: "batchop.a",
          chain: Constants.SOLANA_CHAIN_CODENAME,
          action: BatchOperatorFundingTool.FundingAction.synd,
          transaction: "solana-signature-2",
          amount: minted
        }
      ])
      // The ONE Ethereum write: depositAndStake with the stake attached.
      expect(sendTransaction).toHaveBeenCalledTimes(1)
      const [request] = sendTransaction.mock.calls[0]
      expect(request.to).toBe(DepositorAddress)
      expect(request.value).toBe(ethers.WeiPerEther)
      expect(interfaces.staking.parseTransaction({ data: String(request.data) }).name).toBe(
        EthereumPreLaunchStakingTool.StakingFunction.depositAndStake
      )
      expect(keyPairUtils.ethereumSigner).toHaveBeenCalledWith(account.ethereum, provider)
      // The Solana leg: the deposit of the stake, then a synd of EVERYTHING minted, PreLaunch form.
      expect(SolanaLiqSyndicationTool.depositForLiqsolTransaction).toHaveBeenCalledWith(
        solana,
        expect.objectContaining({ publicKey: expect.anything() }),
        10_000_000_000n,
        expect.any(Number)
      )
      expect(SolanaLiqSyndicationTool.syndTransaction).toHaveBeenCalledWith(
        solana,
        expect.anything(),
        minted,
        WireState.preLaunch
      )
      expect(submit).toHaveBeenCalledTimes(2)
      // The Solana signer is the operator's own ED key, derived through the facade.
      submit.mock.calls.forEach(([, , signer]) =>
        expect(signer.publicKey.toBase58()).toBe(
          keyPairUtils.solanaPublicKey(account.solana).toBase58()
        )
      )
    })

    it("signs the Solana leg through the custody facade — a KMS-shaped signer is what the builders, the balance read and submit receive", async () => {
      const account = await operator("batchop.a"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther },
          stakingAnswers()
        ),
        kmsSigner = {
          publicKey: keyPairUtils.solanaPublicKey(account.solana)
        } as unknown as SolanaSigner,
        solanaSigner = jest
          .spyOn(keyPairUtils, "solanaSigner")
          .mockResolvedValue(kmsSigner),
        minted = 10_000_000_000n
      fakeSigner(account, provider)
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(minted),
        solana = solanaTarget(20_000_000_000n),
        outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(provider),
          solana
        })
      expect(outcome.failure).toBeUndefined()
      expect(solanaSigner).toHaveBeenCalledWith(account.solana)
      expect(SolanaLiqSyndicationTool.depositForLiqsolTransaction).toHaveBeenCalledWith(
        solana,
        kmsSigner,
        10_000_000_000n,
        expect.any(Number)
      )
      expect(SolanaLiqSyndicationTool.readLiqsolBalanceOf).toHaveBeenCalledWith(
        solana,
        kmsSigner.publicKey
      )
      expect(SolanaLiqSyndicationTool.syndTransaction).toHaveBeenCalledWith(
        solana,
        kmsSigner,
        minted,
        WireState.preLaunch
      )
      expect(submit).toHaveBeenCalledTimes(2)
      submit.mock.calls.forEach(([, , signer]) => expect(signer).toBe(kmsSigner))
    })

    it("post-launch: deposit, approve and syndicate the minted liqETH with the operator's compressed key", async () => {
      const account = await operator("batchop.b"),
        minted = 999_999_999_999_999_999n,
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther },
          poolAnswers(minted)
        ),
        { sendTransaction } = fakeSigner(account, provider)
      stubSolanaReads(WireState.postLaunch)
      stubSolanaWrites(minted)
      const outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: postLaunchTarget(provider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.receipts.map(row => [row.chain, row.action, row.transaction, row.amount])).toEqual([
        [Constants.ETHEREUM_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.deposit, "0xethereum-1", ethers.WeiPerEther],
        [Constants.ETHEREUM_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.approve, "0xethereum-2", minted],
        [Constants.ETHEREUM_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.syndicate, "0xethereum-3", minted],
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.solToLiqsol, "solana-signature-1", 10_000_000_000n],
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.synd, "solana-signature-2", minted]
      ])
      const [deposit, approve, syndicate] = sendTransaction.mock.calls.map(([request]) => request)
      expect(deposit.to).toBe(DepositManagerAddress)
      expect(deposit.value).toBe(ethers.WeiPerEther)
      expect(approve.to).toBe(LiqEthAddress)
      expect(interfaces.liqEth.decodeFunctionData("approve", String(approve.data))).toEqual([
        PoolAddress,
        minted
      ])
      expect(syndicate.to).toBe(PoolAddress)
      const [amount, pubkey] = interfaces.pool.decodeFunctionData("syndicate", String(syndicate.data))
      expect(amount).toBe(minted)
      expect(pubkey).toBe(ethers.hexlify(keyPairUtils.ethereumCompressedPubkey(account.ethereum)))
      expect(ethers.computeAddress(pubkey)).toBe(account.ethereum.address)
      expect(SolanaLiqSyndicationTool.syndTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        minted,
        WireState.postLaunch
      )
    })

    it("post-launch refuses a paused pool before any write", async () => {
      const account = await operator("batchop.c"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther },
          poolAnswers(1n, true)
        ),
        { sendTransaction } = fakeSigner(account, provider)
      stubSolanaReads(WireState.postLaunch)
      await expect(
        BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: postLaunchTarget(provider),
          solana: solanaTarget(20_000_000_000n)
        })
      ).rejects.toThrow(/SyndicationPool is paused/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it("stops at the first write failure and reports what landed before it", async () => {
      const first = await operator("batchop.a"),
        second = await operator("batchop.b"),
        balances = {
          [first.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther,
          [second.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther
        },
        provider = fakeProvider(balances, stakingAnswers()),
        minted = 10_000_000_000n
      // Every Ethereum send mines; the SECOND operator's Solana deposit is refused.
      let sent = 0
      const signer = {
        provider,
        getAddress: async () => `0x${"ab".repeat(20)}`,
        sendTransaction: async () => ({ wait: async () => ({ status: 1, hash: `0xethereum-${(sent += 1)}` }) })
      } as unknown as ethers.Signer
      jest.spyOn(keyPairUtils, "ethereumSigner").mockResolvedValue(signer)
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(minted)
      submit
        .mockImplementationOnce(async () => "solana-signature-1")
        .mockImplementationOnce(async () => "solana-signature-2")
        .mockRejectedValueOnce(new Error("custom program error: 0x1dc5"))
      const outcome = await BatchOperatorFundingTool.fund([first, second], DefaultAllocation, {
        ethereum: preLaunchTarget(provider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(outcome.failure).toEqual({
        label: "batchop.b",
        chain: Constants.SOLANA_CHAIN_CODENAME,
        error: expect.objectContaining({ message: "custom program error: 0x1dc5" })
      })
      expect(outcome.receipts.map(row => [row.label, row.action])).toEqual([
        ["batchop.a", BatchOperatorFundingTool.FundingAction.depositAndStake],
        ["batchop.a", BatchOperatorFundingTool.FundingAction.solToLiqsol],
        ["batchop.a", BatchOperatorFundingTool.FundingAction.synd],
        ["batchop.b", BatchOperatorFundingTool.FundingAction.depositAndStake]
      ])
    })

    it("a reverted Ethereum write is the failure, and the Solana leg is never attempted", async () => {
      const account = await operator("batchop.a"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * ethers.WeiPerEther },
          stakingAnswers()
        )
      fakeSigner(account, provider, 0)
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(1n),
        outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(provider),
          solana: solanaTarget(20_000_000_000n)
        })
      expect(outcome.receipts).toEqual([])
      expect(outcome.failure.chain).toBe(Constants.ETHEREUM_CHAIN_CODENAME)
      expect(outcome.failure.error.message).toMatch(/depositAndStake: reverted \(status=0\)/)
      expect(submit).not.toHaveBeenCalled()
    })
  })
})
