import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { isFunction, noop } from "lodash"
import { match, P } from "ts-pattern"
import { Keypair, PublicKey, type Connection } from "@solana/web3.js"
import { KeyType, SlugName } from "@wireio/sdk-core"
import { TokenAmount } from "@wireio/opp-typescript-models"
import {
  AWSAccountName,
  BatchOperatorUnderwritingConfig,
  SignatureProviderKeyPolicy,
  SignatureProviderType,
  type KeyCustodySettings
} from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
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
/** The default allocation's stake + reserve, in chain-native units (1 ETH + 0.05 ETH; 10 SOL + 0.1 SOL). */
const StakeWei = ethers.WeiPerEther
const ReserveWei = ethers.WeiPerEther / 20n
const StakeLamports = 10_000_000_000n
const ReserveLamports = 100_000_000n
/** The 33-byte compressed-key field a `Syndicated` log carries (any bytes encode). */
const CompressedPubkeyLength = 33

/** The part of a hardhat artifact these cases bind: its ABI. */
interface AbiArtifact {
  abi: ethers.InterfaceAbi
}

/** A fake Ethereum provider's answer to one view — static, or live (read at call time). */
type ProviderAnswer = ReadonlyArray<unknown> | (() => ReadonlyArray<unknown>)

/** A fake Ethereum provider's answers, keyed `<address>:<function>`. */
type ProviderAnswers = Record<string, ProviderAnswer>

/**
 * The operator's liqETH holdings and pool allowance the fake chain keeps —
 * moved by the fake signer's mined writes, read by the live answers.
 */
interface LiqEthLedger {
  balance: bigint
  allowance: bigint
}

/** The operator's liqSOL holdings the fake chain keeps — minted by a mined deposit, taken by a mined synd. */
interface LiqsolLedger {
  balance: bigint
}

/** The two Solana writes the stubbed builders mark their transactions with. */
enum FakeSolanaWrite {
  deposit = "deposit",
  synd = "synd"
}

/** A stubbed Solana transaction: the write it stands for and its amount. */
interface FakeSolanaTransaction {
  kind: FakeSolanaWrite
  amount: bigint
}

/** The fake signer a case inspects. */
interface FakeSigner {
  sendTransaction: jest.Mock
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

/** A fresh, empty liqETH ledger. */
const emptyLiqEth = (): LiqEthLedger => ({ balance: 0n, allowance: 0n })

/** Whether `filter` admits `log`: the address, then each topic position (null = any, an array = any of). */
function logMatches(filter: ethers.Filter, log: ethers.LogParams): boolean {
  return (
    String(filter.address).toLowerCase() === log.address.toLowerCase() &&
    (filter.topics ?? []).every((topic, index) =>
      match(topic)
        .with(P.nullish, () => true)
        .with(P.array(P.string), candidates => candidates.includes(log.topics[index]))
        .otherwise(single => single === log.topics[index])
    )
  )
}

/** The fake chain's effect of a mined Solana write. */
function applySolanaWrite(ledger: LiqsolLedger, transaction: FakeSolanaTransaction): void {
  match(transaction.kind)
    .with(FakeSolanaWrite.deposit, () => {
      ledger.balance += transaction.amount
    })
    .with(FakeSolanaWrite.synd, () => {
      ledger.balance -= transaction.amount
    })
    .exhaustive()
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

  /** The two outpost key pairs a case needs, generated in-process — the funding identity. */
  async function operator(label: string): Promise<BatchOperatorFundingTool.FundedOperator> {
    const context = KeyGenerator.context()
    return {
      label,
      ethereum: await KeyGenerator.create(KeyType.EM, context),
      solana: await KeyGenerator.create(KeyType.ED, context)
    }
  }

  /**
   * The fake chain's effect of a mined Ethereum write: a deposit mints liqETH
   * 1:1, an approve sets the pool's allowance, a syndicate takes both; the
   * Depositor's `depositAndStake` moves nothing the fake tracks.
   */
  function applyEthereumWrite(ledger: LiqEthLedger, request: ethers.TransactionRequest): void {
    match(String(request.to).toLowerCase())
      .with(DepositManagerAddress, () => {
        ledger.balance += BigInt(request.value ?? 0)
      })
      .with(LiqEthAddress, () => {
        const [, amount] = interfaces.liqEth.decodeFunctionData(
          EthereumSyndicationTool.LiqEthFunction.approve,
          String(request.data)
        )
        ledger.allowance = BigInt(amount)
      })
      .with(PoolAddress, () => {
        const [amount] = interfaces.pool.decodeFunctionData(
          EthereumSyndicationTool.PoolFunction.syndicate,
          String(request.data)
        )
        ledger.balance -= BigInt(amount)
        ledger.allowance -= BigInt(amount)
      })
      .otherwise(noop)
  }

  /**
   * A provider answering `getNetwork` / `getBalance` / `getTransactionCount`,
   * each contract view from `answers`, and `getLogs` from `logs` (filtered by
   * address + topics, as a node would) — what every Ethereum read and the
   * nonce seed go through.
   */
  function fakeProvider(
    balances: Record<string, bigint>,
    answers: ProviderAnswers,
    chainId: number = ChainId,
    logs: ReadonlyArray<ethers.LogParams> = []
  ): ethers.Provider {
    const provider = {
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
        return iface.encodeFunctionResult(fragment, isFunction(answer) ? answer() : answer)
      },
      getLogs: async (filter: ethers.Filter) =>
        logs
          .filter(log => logMatches(filter, log))
          .map(log => new ethers.Log(log, provider as unknown as ethers.Provider))
    }
    // ethers reaches a runner's provider through `.provider`; the fake is its own.
    return Object.assign(provider, { provider }) as unknown as ethers.Provider
  }

  /** A real ABI-encoded `Syndicated` log of the pool for `syndicator`. */
  function syndicatedLog(syndicator: string, nativeTaken: bigint): ethers.LogParams {
    const { data, topics } = interfaces.pool.encodeEventLog(
      EthereumSyndicationTool.PoolEvent.Syndicated,
      [syndicator, ethers.hexlify(new Uint8Array(CompressedPubkeyLength)), nativeTaken, 1n, 1n]
    )
    return {
      address: PoolAddress,
      data,
      topics,
      blockHash: ethers.ZeroHash,
      blockNumber: 1,
      transactionHash: ethers.ZeroHash,
      transactionIndex: 0,
      index: 0,
      removed: false
    }
  }

  /** A pre-launch target: the staking proxy recorded, with the liqEth book beside it. */
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

  /** The pre-launch gate answers of a staking proxy, and the operator's shares on it. */
  function stakingAnswers(
    gate: Partial<EthereumPreLaunchStakingTool.LaunchGate> = {},
    shares = 0n
  ): ProviderAnswers {
    const { dDay = false, refundActive = false, paused = false } = gate
    return {
      [`${DepositorAddress}:dDay`]: [dDay],
      [`${DepositorAddress}:isRefundActive`]: [refundActive],
      [`${DepositorAddress}:paused`]: [paused],
      [`${DepositorAddress}:sharesOf`]: [shares]
    }
  }

  /** The post-launch pool answers, and the liqETH balance + allowance read live off `ledger`. */
  function poolAnswers(ledger: LiqEthLedger, paused = false): ProviderAnswers {
    return {
      [`${PoolAddress}:paused`]: [paused],
      [`${PoolAddress}:maxSyndicationPerTransfer`]: [EthereumMaxSyndication],
      [`${PoolAddress}:yieldDeadband`]: [1n],
      [`${PoolAddress}:liqTokenCode`]: [1n],
      [`${PoolAddress}:liqTokenPrecision`]: [18n],
      [`${LiqEthAddress}:balanceOf`]: () => [ledger.balance],
      [`${LiqEthAddress}:allowance`]: () => [ledger.allowance]
    }
  }

  /** The Solana reads every funding case stubs — a fundable outpost in `wireState`, the operator holding `position` and no liqSOL. */
  function stubSolanaReads(wireState: WireState, position = 0n): void {
    jest.spyOn(SolanaLiqSyndicationTool, "readWireState").mockResolvedValue(wireState)
    jest.spyOn(SolanaLiqSyndicationTool, "readGlobalStateFrozen").mockResolvedValue(false)
    jest.spyOn(SolanaLiqSyndicationTool, "readGlobalStatePaused").mockResolvedValue(false)
    jest.spyOn(SolanaLiqSyndicationTool, "readGlobalConfig").mockResolvedValue({
      admin: PublicKey.default,
      panic: PublicKey.default,
      maxSyndicationPerTransfer: SolanaMaxSyndication
    })
    jest.spyOn(SolanaLiqSyndicationTool, "readSyndicatedPosition").mockResolvedValue(position)
    jest.spyOn(SolanaLiqSyndicationTool, "readLiqsolBalanceOf").mockResolvedValue(0n)
  }

  /**
   * The Solana writes, stubbed over a fake chain: the builders mark their
   * transactions, `submit` applies each to `ledger` and returns signatures in
   * order, and the liqSOL balance is read live off the ledger.
   */
  function stubSolanaWrites(ledger: LiqsolLedger = { balance: 0n }): jest.SpyInstance {
    jest.spyOn(SolanaLiqSyndicationTool, "waitForEpochRewardsIdle").mockResolvedValue()
    jest
      .spyOn(SolanaLiqSyndicationTool, "submitWithEpochRewardsRetry")
      .mockImplementation((_source, _label, send) => send())
    jest
      .spyOn(SolanaLiqSyndicationTool, "depositForLiqsolTransaction")
      .mockImplementation(
        async (_source, _user, lamports) =>
          ({ kind: FakeSolanaWrite.deposit, amount: lamports }) as never
      )
    jest
      .spyOn(SolanaLiqSyndicationTool, "syndTransaction")
      .mockImplementation(
        async (_source, _user, amount) => ({ kind: FakeSolanaWrite.synd, amount }) as never
      )
    jest
      .spyOn(SolanaLiqSyndicationTool, "readLiqsolBalanceOf")
      .mockImplementation(async () => ledger.balance)
    let sent = 0
    return jest
      .spyOn(SolanaLiqSyndicationTool, "submit")
      .mockImplementation(async (_source, transaction) => {
        applySolanaWrite(ledger, transaction as unknown as FakeSolanaTransaction)
        return `solana-signature-${(sent += 1)}`
      })
  }

  /**
   * A signer double over the fake chain: send `n` mines with `statuses[n]`
   * (`1` when unlisted), hashed in order, and a mined write moves `ledger`.
   */
  function fakeSigner(
    account: BatchOperatorFundingTool.FundedOperator,
    provider: ethers.Provider,
    statuses: readonly number[] = [],
    ledger: LiqEthLedger = emptyLiqEth()
  ): FakeSigner {
    let sent = 0
    const sendTransaction = jest.fn(async (request: ethers.TransactionRequest) => {
        const ordinal = (sent += 1),
          status = statuses[ordinal - 1] ?? 1
        if (status === 1) applyEthereumWrite(ledger, request)
        return { wait: async () => ({ status, hash: `0xethereum-${ordinal}` }) }
      }),
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
    it("FundingAction / EthereumLaunchPhase / SkipReason are identity enums", () => {
      Object.entries(BatchOperatorFundingTool.FundingAction).forEach(([key, value]) =>
        expect(value).toBe(key)
      )
      Object.entries(BatchOperatorFundingTool.EthereumLaunchPhase).forEach(
        ([key, value]) => expect(value).toBe(key)
      )
      Object.entries(BatchOperatorFundingTool.SkipReason).forEach(([key, value]) =>
        expect(value).toBe(key)
      )
    })

    it("converts depot units to wei (×10^9) and lamports (×1)", () => {
      expect(BatchOperatorFundingTool.WeiPerDepotUnit).toBe(1_000_000_000n)
      expect(BatchOperatorFundingTool.LamportsPerDepotUnit).toBe(1n)
      expect(BatchOperatorFundingTool.nativeUnits(3n, BatchOperatorFundingTool.WeiPerDepotUnit)).toBe(
        3_000_000_000n
      )
      expect(BatchOperatorFundingTool.nativeAllocation(DefaultAllocation)).toEqual({
        stakeWei: StakeWei,
        reserveWei: ReserveWei,
        stakeLamports: StakeLamports,
        reserveLamports: ReserveLamports
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

    it("requiredNative adds the stake only while the leg still deposits native value", () => {
      const { FundingAction, requiredNative } = BatchOperatorFundingTool
      expect(
        requiredNative({ position: 0n, writes: [FundingAction.depositAndStake] }, StakeWei, ReserveWei)
      ).toBe(StakeWei + ReserveWei)
      expect(
        requiredNative(
          { position: 0n, writes: [FundingAction.deposit, FundingAction.approve, FundingAction.syndicate] },
          StakeWei,
          ReserveWei
        )
      ).toBe(StakeWei + ReserveWei)
      expect(
        requiredNative(
          { position: 0n, writes: [FundingAction.approve, FundingAction.syndicate] },
          StakeWei,
          ReserveWei
        )
      ).toBe(ReserveWei)
      expect(
        requiredNative({ position: 0n, writes: [FundingAction.solToLiqsol, FundingAction.synd] }, StakeLamports, ReserveLamports)
      ).toBe(StakeLamports + ReserveLamports)
      expect(
        requiredNative({ position: 0n, writes: [FundingAction.synd] }, StakeLamports, ReserveLamports)
      ).toBe(ReserveLamports)
      expect(requiredNative({ position: 5n, writes: [] }, StakeLamports, ReserveLamports)).toBe(
        ReserveLamports
      )
    })

    it("toListingJson renders the receipts and the skips, bigint amounts as decimal strings", () => {
      const listing = BatchOperatorFundingTool.toListingJson({
        receipts: [
          {
            label: "batchop.a",
            chain: Constants.ETHEREUM_CHAIN_CODENAME,
            action: BatchOperatorFundingTool.FundingAction.depositAndStake,
            transaction: "0xabc",
            amount: 1_000_000_000_000_000_000n
          }
        ],
        skips: [
          {
            label: "batchop.b",
            chain: Constants.SOLANA_CHAIN_CODENAME,
            reason: BatchOperatorFundingTool.SkipReason.existingPosition,
            amount: 10_000_000_000n
          }
        ]
      })
      expect(JSON.parse(listing)).toEqual({
        receipts: [
          {
            label: "batchop.a",
            chain: "ETHEREUM",
            action: "depositAndStake",
            transaction: "0xabc",
            amount: "1000000000000000000"
          }
        ],
        skips: [
          {
            label: "batchop.b",
            chain: "SOLANA",
            reason: "existingPosition",
            amount: "10000000000"
          }
        ]
      })
      expect(listing.startsWith('{\n  "receipts": [')).toBe(true)
    })

    it("toListingJson prints the two lists and nothing else of an outcome", () => {
      const outcome: BatchOperatorFundingTool.Outcome = {
        receipts: [],
        skips: [],
        failure: {
          label: "batchop.a",
          chain: Constants.ETHEREUM_CHAIN_CODENAME,
          error: new Error("reverted")
        }
      }
      expect(JSON.parse(BatchOperatorFundingTool.toListingJson(outcome))).toEqual({
        receipts: [],
        skips: []
      })
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

    it("adopts the ED and EM keys under the adopt-only policy — never the K1 — and assembles the identities", async () => {
      const pairs = await operator("batchop.a"),
        adopt = jest
          .spyOn(KeySteps, "adoptOrCreateSignatureProviderKey")
          .mockImplementation(async (adopting, keyType) => {
            expect(adopting.signatureProvider.batchOperatorKeyPolicy).toBe(
              SignatureProviderKeyPolicy.adoptOnly
            )
            return keyType === KeyType.EM ? pairs.ethereum : pairs.solana
          }),
        [adopted] = await BatchOperatorFundingTool.adoptOperators(
          settings,
          ["batchop.a"],
          KeyGenerator.context()
        )
      expect(adopt).toHaveBeenCalledTimes(2)
      const requested = adopt.mock.calls.map(([, keyType]) => keyType)
      expect(new Set(requested)).toEqual(new Set([KeyType.ED, KeyType.EM]))
      expect(requested).not.toContain(KeyType.K1)
      expect(adopted).toEqual({
        label: "batchop.a",
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
    it("refuses an operator whose balance is below what its leg requires, on either outpost", async () => {
      const account = await operator("batchop.a")
      stubSolanaReads(WireState.preLaunch)
      await expect(
        BatchOperatorFundingTool.assertFundable([account], DefaultAllocation, {
          ethereum: preLaunchTarget(
            fakeProvider({ [account.ethereum.address.toLowerCase()]: StakeWei }, stakingAnswers())
          ),
          solana: solanaTarget(20_000_000_000n)
        })
      ).rejects.toThrow(/batchop\.a's Ethereum balance 1000000000000000000 wei .* is below the required 1050000000000000000 wei/)
      await expect(
        BatchOperatorFundingTool.assertFundable([account], DefaultAllocation, {
          ethereum: preLaunchTarget(
            fakeProvider({ [account.ethereum.address.toLowerCase()]: 2n * StakeWei }, stakingAnswers())
          ),
          solana: solanaTarget(StakeLamports)
        })
      ).rejects.toThrow(/batchop\.a's Solana balance 10000000000 lamports .* is below the required 10100000000 lamports/)
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
          fakeProvider({ [account.ethereum.address.toLowerCase()]: 2n * StakeWei }, stakingAnswers())
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

    it("plans both legs from the chain — every write while nothing is staked or held", async () => {
      const account = await operator("batchop.a"),
        { FundingAction } = BatchOperatorFundingTool
      stubSolanaReads(WireState.preLaunch)
      const preflight = await BatchOperatorFundingTool.assertFundable([account], DefaultAllocation, {
        ethereum: preLaunchTarget(
          fakeProvider({ [account.ethereum.address.toLowerCase()]: 2n * StakeWei }, stakingAnswers())
        ),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(preflight.ethereumPhase).toBe(BatchOperatorFundingTool.EthereumLaunchPhase.preLaunch)
      expect(preflight.wireState).toBe(WireState.preLaunch)
      expect(preflight.plans).toEqual([
        {
          operator: account,
          ethereum: { position: 0n, writes: [FundingAction.depositAndStake] },
          solana: { position: 0n, writes: [FundingAction.solToLiqsol, FundingAction.synd] }
        }
      ])
    })
  })

  describe("fund", () => {
    it("pre-launch: one depositAndStake, then sol_to_liqsol + synd of exactly the stake in the PreLaunch form", async () => {
      const account = await operator("batchop.a"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * StakeWei },
          stakingAnswers()
        ),
        { sendTransaction } = fakeSigner(account, provider)
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(),
        solana = solanaTarget(20_000_000_000n),
        outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(provider),
          solana
        })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.skips).toEqual([])
      expect(outcome.receipts).toEqual([
        {
          label: "batchop.a",
          chain: Constants.ETHEREUM_CHAIN_CODENAME,
          action: BatchOperatorFundingTool.FundingAction.depositAndStake,
          transaction: "0xethereum-1",
          amount: StakeWei
        },
        {
          label: "batchop.a",
          chain: Constants.SOLANA_CHAIN_CODENAME,
          action: BatchOperatorFundingTool.FundingAction.solToLiqsol,
          transaction: "solana-signature-1",
          amount: StakeLamports
        },
        {
          label: "batchop.a",
          chain: Constants.SOLANA_CHAIN_CODENAME,
          action: BatchOperatorFundingTool.FundingAction.synd,
          transaction: "solana-signature-2",
          amount: StakeLamports
        }
      ])
      // The ONE Ethereum write: depositAndStake with the stake attached.
      expect(sendTransaction).toHaveBeenCalledTimes(1)
      const [request] = sendTransaction.mock.calls[0]
      expect(request.to).toBe(DepositorAddress)
      expect(request.value).toBe(StakeWei)
      expect(interfaces.staking.parseTransaction({ data: String(request.data) }).name).toBe(
        EthereumPreLaunchStakingTool.StakingFunction.depositAndStake
      )
      expect(keyPairUtils.ethereumSigner).toHaveBeenCalledWith(account.ethereum, provider)
      // The Solana leg: the deposit of the stake, then a synd of EXACTLY the stake, PreLaunch form.
      expect(SolanaLiqSyndicationTool.depositForLiqsolTransaction).toHaveBeenCalledWith(
        solana,
        expect.objectContaining({ publicKey: expect.anything() }),
        StakeLamports,
        expect.any(Number)
      )
      expect(SolanaLiqSyndicationTool.syndTransaction).toHaveBeenCalledWith(
        solana,
        expect.anything(),
        StakeLamports,
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
          { [account.ethereum.address.toLowerCase()]: 2n * StakeWei },
          stakingAnswers()
        ),
        kmsSigner = {
          publicKey: keyPairUtils.solanaPublicKey(account.solana)
        } as unknown as SolanaSigner,
        solanaSigner = jest
          .spyOn(keyPairUtils, "solanaSigner")
          .mockResolvedValue(kmsSigner)
      fakeSigner(account, provider)
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(),
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
        StakeLamports,
        expect.any(Number)
      )
      expect(SolanaLiqSyndicationTool.readLiqsolBalanceOf).toHaveBeenCalledWith(
        solana,
        kmsSigner.publicKey
      )
      expect(SolanaLiqSyndicationTool.syndTransaction).toHaveBeenCalledWith(
        solana,
        kmsSigner,
        StakeLamports,
        WireState.preLaunch
      )
      expect(submit).toHaveBeenCalledTimes(2)
      submit.mock.calls.forEach(([, , signer]) => expect(signer).toBe(kmsSigner))
    })

    it("post-launch: deposit, approve and syndicate EXACTLY the stake with the operator's compressed key", async () => {
      const account = await operator("batchop.b"),
        ledger = emptyLiqEth(),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * StakeWei },
          poolAnswers(ledger)
        ),
        { sendTransaction } = fakeSigner(account, provider, [], ledger)
      stubSolanaReads(WireState.postLaunch)
      stubSolanaWrites()
      const outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: postLaunchTarget(provider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.skips).toEqual([])
      expect(outcome.receipts.map(row => [row.chain, row.action, row.transaction, row.amount])).toEqual([
        [Constants.ETHEREUM_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.deposit, "0xethereum-1", StakeWei],
        [Constants.ETHEREUM_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.approve, "0xethereum-2", StakeWei],
        [Constants.ETHEREUM_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.syndicate, "0xethereum-3", StakeWei],
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.solToLiqsol, "solana-signature-1", StakeLamports],
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.synd, "solana-signature-2", StakeLamports]
      ])
      const [deposit, approve, syndicate] = sendTransaction.mock.calls.map(([request]) => request)
      expect(deposit.to).toBe(DepositManagerAddress)
      expect(deposit.value).toBe(StakeWei)
      expect(approve.to).toBe(LiqEthAddress)
      expect(interfaces.liqEth.decodeFunctionData("approve", String(approve.data))).toEqual([
        PoolAddress,
        StakeWei
      ])
      expect(syndicate.to).toBe(PoolAddress)
      const [amount, pubkey] = interfaces.pool.decodeFunctionData("syndicate", String(syndicate.data))
      expect(amount).toBe(StakeWei)
      expect(pubkey).toBe(ethers.hexlify(keyPairUtils.ethereumCompressedPubkey(account.ethereum)))
      expect(ethers.computeAddress(pubkey)).toBe(account.ethereum.address)
      // The fake chain took exactly the stake: nothing minted is left behind, no allowance lingers.
      expect(ledger).toEqual({ balance: 0n, allowance: 0n })
      expect(SolanaLiqSyndicationTool.syndTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        StakeLamports,
        WireState.postLaunch
      )
    })

    it("post-launch refuses a paused pool before any write", async () => {
      const account = await operator("batchop.c"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * StakeWei },
          poolAnswers(emptyLiqEth(), true)
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
          [first.ethereum.address.toLowerCase()]: 2n * StakeWei,
          [second.ethereum.address.toLowerCase()]: 2n * StakeWei
        },
        provider = fakeProvider(balances, stakingAnswers())
      // Every Ethereum send mines; the SECOND operator's Solana deposit is refused.
      let sent = 0
      const signer = {
        provider,
        getAddress: async () => `0x${"ab".repeat(20)}`,
        sendTransaction: async () => ({ wait: async () => ({ status: 1, hash: `0xethereum-${(sent += 1)}` }) })
      } as unknown as ethers.Signer
      jest.spyOn(keyPairUtils, "ethereumSigner").mockResolvedValue(signer)
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(),
        mined = submit.getMockImplementation()
      submit
        .mockImplementationOnce(mined)
        .mockImplementationOnce(mined)
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
          { [account.ethereum.address.toLowerCase()]: 2n * StakeWei },
          stakingAnswers()
        )
      fakeSigner(account, provider, [0])
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(),
        outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(provider),
          solana: solanaTarget(20_000_000_000n)
        })
      expect(outcome.receipts).toEqual([])
      expect(outcome.failure.chain).toBe(Constants.ETHEREUM_CHAIN_CODENAME)
      expect(outcome.failure.error.message).toMatch(/depositAndStake: reverted \(status=0\)/)
      expect(submit).not.toHaveBeenCalled()
    })

    it("skips an operator already holding Depositor shares (pre-launch): no Ethereum write, the reserve alone required", async () => {
      const account = await operator("batchop.a"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: ReserveWei },
          stakingAnswers({}, 42n)
        ),
        { sendTransaction } = fakeSigner(account, provider)
      stubSolanaReads(WireState.preLaunch)
      const submit = stubSolanaWrites(),
        outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(provider),
          solana: solanaTarget(20_000_000_000n)
        })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.skips).toEqual([
        {
          label: "batchop.a",
          chain: Constants.ETHEREUM_CHAIN_CODENAME,
          reason: BatchOperatorFundingTool.SkipReason.existingPosition,
          amount: 42n
        }
      ])
      expect(sendTransaction).not.toHaveBeenCalled()
      expect(keyPairUtils.ethereumSigner).not.toHaveBeenCalled()
      expect(outcome.receipts.map(row => [row.chain, row.action])).toEqual([
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.solToLiqsol],
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.synd]
      ])
      expect(submit).toHaveBeenCalledTimes(2)
    })

    it("skips an operator already syndicated on the pool (post-launch), scanning Syndicated by its own address", async () => {
      const account = await operator("batchop.b"),
        other = await operator("batchop.c"),
        ledger = emptyLiqEth(),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: ReserveWei },
          poolAnswers(ledger),
          ChainId,
          [
            syndicatedLog(other.ethereum.address, 7n * 10n ** 17n),
            syndicatedLog(account.ethereum.address, 3n * 10n ** 17n),
            syndicatedLog(account.ethereum.address, 7n * 10n ** 17n)
          ]
        ),
        { sendTransaction } = fakeSigner(account, provider, [], ledger)
      stubSolanaReads(WireState.postLaunch)
      stubSolanaWrites()
      const outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: postLaunchTarget(provider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.skips).toEqual([
        {
          label: "batchop.b",
          chain: Constants.ETHEREUM_CHAIN_CODENAME,
          reason: BatchOperatorFundingTool.SkipReason.existingPosition,
          amount: StakeWei
        }
      ])
      expect(sendTransaction).not.toHaveBeenCalled()
      expect(outcome.receipts.map(row => row.chain)).toEqual([
        Constants.SOLANA_CHAIN_CODENAME,
        Constants.SOLANA_CHAIN_CODENAME
      ])
    })

    it("skips an operator whose pre-launch Depositor shares carry past D-Day (post-launch, the Depositor still recorded)", async () => {
      const account = await operator("batchop.a"),
        ledger = emptyLiqEth(),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: ReserveWei },
          { ...stakingAnswers({ dDay: true }, 9n), ...poolAnswers(ledger) }
        ),
        { sendTransaction } = fakeSigner(account, provider, [], ledger)
      stubSolanaReads(WireState.postLaunch)
      stubSolanaWrites()
      const outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: preLaunchTarget(provider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.skips).toEqual([
        {
          label: "batchop.a",
          chain: Constants.ETHEREUM_CHAIN_CODENAME,
          reason: BatchOperatorFundingTool.SkipReason.existingPosition,
          amount: 9n
        }
      ])
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it("skips an operator already syndicated on Solana: no Solana write, the reserve alone required", async () => {
      const account = await operator("batchop.a"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * StakeWei },
          stakingAnswers()
        ),
        solanaSigner = jest.spyOn(keyPairUtils, "solanaSigner")
      fakeSigner(account, provider)
      stubSolanaReads(WireState.preLaunch, 5_000_000_000n)
      const submit = stubSolanaWrites(),
        solana = solanaTarget(ReserveLamports),
        outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(provider),
          solana
        })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.skips).toEqual([
        {
          label: "batchop.a",
          chain: Constants.SOLANA_CHAIN_CODENAME,
          reason: BatchOperatorFundingTool.SkipReason.existingPosition,
          amount: 5_000_000_000n
        }
      ])
      expect(outcome.receipts.map(row => row.action)).toEqual([
        BatchOperatorFundingTool.FundingAction.depositAndStake
      ])
      expect(SolanaLiqSyndicationTool.readSyndicatedPosition).toHaveBeenCalledWith(
        solana,
        keyPairUtils.solanaPublicKey(account.solana)
      )
      expect(submit).not.toHaveBeenCalled()
      expect(solanaSigner).not.toHaveBeenCalled()
    })

    it("resumes a post-launch Ethereum leg: liqETH covering the stake skips the deposit, an allowance covering it skips the approve", async () => {
      const account = await operator("batchop.b"),
        held: LiqEthLedger = { balance: StakeWei, allowance: 0n },
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: ReserveWei },
          poolAnswers(held)
        ),
        { sendTransaction } = fakeSigner(account, provider, [], held)
      stubSolanaReads(WireState.postLaunch)
      stubSolanaWrites()
      const outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: postLaunchTarget(provider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.skips).toEqual([])
      expect(
        outcome.receipts
          .filter(row => row.chain === Constants.ETHEREUM_CHAIN_CODENAME)
          .map(row => [row.action, row.amount])
      ).toEqual([
        [BatchOperatorFundingTool.FundingAction.approve, StakeWei],
        [BatchOperatorFundingTool.FundingAction.syndicate, StakeWei]
      ])
      expect(sendTransaction.mock.calls.map(([request]) => request.to)).toEqual([
        LiqEthAddress,
        PoolAddress
      ])
      expect(held).toEqual({ balance: 0n, allowance: 0n })

      jest.restoreAllMocks()
      const approved: LiqEthLedger = { balance: StakeWei, allowance: StakeWei },
        approvedProvider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: ReserveWei },
          poolAnswers(approved)
        ),
        approvedSigner = fakeSigner(account, approvedProvider, [], approved)
      stubSolanaReads(WireState.postLaunch)
      stubSolanaWrites()
      const again = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: postLaunchTarget(approvedProvider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(again.failure).toBeUndefined()
      expect(
        again.receipts
          .filter(row => row.chain === Constants.ETHEREUM_CHAIN_CODENAME)
          .map(row => [row.action, row.amount])
      ).toEqual([[BatchOperatorFundingTool.FundingAction.syndicate, StakeWei]])
      expect(approvedSigner.sendTransaction).toHaveBeenCalledTimes(1)
      expect(approved).toEqual({ balance: 0n, allowance: 0n })
    })

    it("resumes a Solana leg: liqSOL covering the stake skips sol_to_liqsol, and synd is exactly the stake", async () => {
      const account = await operator("batchop.a"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: 2n * StakeWei },
          stakingAnswers()
        )
      fakeSigner(account, provider)
      stubSolanaReads(WireState.preLaunch)
      const held: LiqsolLedger = { balance: StakeLamports + 1n },
        submit = stubSolanaWrites(held),
        outcome = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(provider),
          solana: solanaTarget(ReserveLamports)
        })
      expect(outcome.failure).toBeUndefined()
      expect(outcome.skips).toEqual([])
      expect(
        outcome.receipts
          .filter(row => row.chain === Constants.SOLANA_CHAIN_CODENAME)
          .map(row => [row.action, row.amount])
      ).toEqual([[BatchOperatorFundingTool.FundingAction.synd, StakeLamports]])
      expect(SolanaLiqSyndicationTool.depositForLiqsolTransaction).not.toHaveBeenCalled()
      expect(submit).toHaveBeenCalledTimes(1)
      // Exactly the stake left the wallet.
      expect(held.balance).toBe(1n)
    })

    it("a re-run after a failed approve deposits no second time, and needs only the reserve", async () => {
      const account = await operator("batchop.b"),
        ledger = emptyLiqEth(),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: StakeWei + ReserveWei },
          poolAnswers(ledger)
        ),
        first = fakeSigner(account, provider, [1, 0], ledger)
      stubSolanaReads(WireState.postLaunch)
      stubSolanaWrites()
      const interrupted = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: postLaunchTarget(provider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(interrupted.failure).toMatchObject({
        label: "batchop.b",
        chain: Constants.ETHEREUM_CHAIN_CODENAME
      })
      expect(interrupted.failure.error.message).toMatch(/approve: reverted \(status=0\)/)
      expect(interrupted.receipts.map(row => row.action)).toEqual([
        BatchOperatorFundingTool.FundingAction.deposit
      ])
      expect(ledger).toEqual({ balance: StakeWei, allowance: 0n })

      jest.restoreAllMocks()
      // The ETH is now liqETH: the operator holds the reserve alone, and the re-run asks for no more.
      const resumedProvider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: ReserveWei },
          poolAnswers(ledger)
        ),
        second = fakeSigner(account, resumedProvider, [], ledger)
      stubSolanaReads(WireState.postLaunch)
      stubSolanaWrites()
      const resumed = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: postLaunchTarget(resumedProvider),
        solana: solanaTarget(20_000_000_000n)
      })
      expect(resumed.failure).toBeUndefined()
      expect(resumed.receipts.map(row => [row.chain, row.action])).toEqual([
        [Constants.ETHEREUM_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.approve],
        [Constants.ETHEREUM_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.syndicate],
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.solToLiqsol],
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.synd]
      ])
      const deposits = [
        ...first.sendTransaction.mock.calls,
        ...second.sendTransaction.mock.calls
      ].filter(([request]) => String(request.to).toLowerCase() === DepositManagerAddress)
      expect(deposits).toHaveLength(1)
      expect(ledger).toEqual({ balance: 0n, allowance: 0n })
    })

    it("a re-run after a failed synd deposits no second time on Solana, and needs only the reserve", async () => {
      const account = await operator("batchop.a"),
        provider = fakeProvider(
          { [account.ethereum.address.toLowerCase()]: StakeWei + ReserveWei },
          stakingAnswers()
        )
      fakeSigner(account, provider)
      stubSolanaReads(WireState.preLaunch)
      const liqsol: LiqsolLedger = { balance: 0n },
        submit = stubSolanaWrites(liqsol),
        mined = submit.getMockImplementation()
      submit
        .mockImplementationOnce(mined)
        .mockRejectedValueOnce(new Error("custom program error: 0x1dc5"))
      const interrupted = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
        ethereum: preLaunchTarget(provider),
        solana: solanaTarget(StakeLamports + ReserveLamports)
      })
      expect(interrupted.failure).toMatchObject({
        label: "batchop.a",
        chain: Constants.SOLANA_CHAIN_CODENAME
      })
      expect(interrupted.receipts.map(row => row.action)).toEqual([
        BatchOperatorFundingTool.FundingAction.depositAndStake,
        BatchOperatorFundingTool.FundingAction.solToLiqsol
      ])
      expect(liqsol.balance).toBe(StakeLamports)

      jest.restoreAllMocks()
      // The Ethereum stake landed (Depositor shares) and the SOL is now liqSOL: both outposts need the reserve alone.
      const resumedProvider = fakeProvider(
        { [account.ethereum.address.toLowerCase()]: ReserveWei },
        stakingAnswers({}, 1n)
      )
      fakeSigner(account, resumedProvider)
      stubSolanaReads(WireState.preLaunch)
      const resumedSubmit = stubSolanaWrites(liqsol),
        resumed = await BatchOperatorFundingTool.fund([account], DefaultAllocation, {
          ethereum: preLaunchTarget(resumedProvider),
          solana: solanaTarget(ReserveLamports)
        })
      expect(resumed.failure).toBeUndefined()
      expect(resumed.skips.map(row => row.chain)).toEqual([Constants.ETHEREUM_CHAIN_CODENAME])
      expect(resumed.receipts.map(row => [row.chain, row.action, row.amount])).toEqual([
        [Constants.SOLANA_CHAIN_CODENAME, BatchOperatorFundingTool.FundingAction.synd, StakeLamports]
      ])
      expect(SolanaLiqSyndicationTool.depositForLiqsolTransaction).not.toHaveBeenCalled()
      expect(resumedSubmit).toHaveBeenCalledTimes(1)
      expect(liqsol.balance).toBe(0n)
    })
  })
})
