import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { EthereumOutpostBootstrapper } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { EthereumSyndicationTool } from "@wireio/cluster-tool/tools/ethereum"

/**
 * The `SyndicationPool` and `DepositManager` ABIs, TRIMMED from wire-ethereum's
 * hardhat artifacts (feature/syndication-underwriting d4fbb8f8, whose compiled
 * sources match that commit) to the functions this tool calls. Staged into a
 * fake `artifacts/` tree so the tool's own loaders read them, exactly as they
 * read the real ones at run time.
 */
const SyndicationPoolFixture = "syndicationPool.abi.json"
const DepositManagerFixture = "depositManager.abi.json"
/** `LiqEthToken` (liqEth/v1/liqEth.sol) and `OutpostManagerAuthority`, trimmed the same way. */
const LiqEthTokenFixture = "liqEthToken.abi.json"
const OutpostManagerFixture = "outpostManager.abi.json"
const OutpostManagerAuthorityFixture = "outpostManagerAuthority.abi.json"

/** Deployed addresses the staged address maps carry. */
const PoolAddress = "0x00000000000000000000000000000000000000a1"
const LiqEthAddress = "0x00000000000000000000000000000000000000a2"
const DepositManagerAddress = "0x00000000000000000000000000000000000000a3"
const ManagerAddress = "0x00000000000000000000000000000000000000a5"
const AccessManagerAddress = "0x00000000000000000000000000000000000000a4"

/** An anvil HD index a flow-owned holder might use. */
const HolderIndex = 48

/** The four-byte selector of a Solidity signature. */
const selector = (signature: string): string =>
  ethers.id(signature).slice(0, 10)

/** A hardhat artifact, as far as the loaders read it. */
interface ArtifactFixture {
  abi: ethers.InterfaceAbi
}

/** Read a trimmed artifact fixture. */
function fixture(name: string): ArtifactFixture {
  return JSON.parse(
    Fs.readFileSync(Path.join(__dirname, "..", "..", "fixtures", name), "utf8")
  )
}

/** Stage `<ethereumPath>/artifacts/contracts/<subpath>/<source>.sol/<name>.json`. */
function stageArtifact(
  ethereumPath: string,
  subpath: ReadonlyArray<string>,
  name: string,
  artifact: ArtifactFixture,
  source: string = name
): void {
  const directory = Path.join(
    ethereumPath,
    "artifacts",
    "contracts",
    ...subpath,
    `${source}.sol`
  )
  Fs.mkdirSync(directory, { recursive: true })
  Fs.writeFileSync(Path.join(directory, `${name}.json`), JSON.stringify(artifact))
}

describe("EthereumSyndicationTool", () => {
  let root: string
  let ethereumPath: string
  let dataPath: string
  const poolInterface = new ethers.Interface(fixture(SyndicationPoolFixture).abi),
    accessManagerInterface = new ethers.Interface(
      fixture(OutpostManagerAuthorityFixture).abi
    ),
    liqEthInterface = new ethers.Interface(fixture(LiqEthTokenFixture).abi)

  /**
   * A read-only contract runner answering each view from `answers`, keyed by
   * `<address>:<function>` — what `ctx.ethereum.provider` is to the readers.
   */
  function answeringRunner(
    answers: Record<string, ReadonlyArray<unknown>>
  ): ethers.ContractRunner {
    const interfaces = [poolInterface, accessManagerInterface, liqEthInterface]
    return {
      provider: null,
      call: async (transaction: ethers.TransactionRequest) => {
        const to = String(transaction.to).toLowerCase(),
          iface = interfaces.find(candidate =>
            candidate.getFunction(String(transaction.data).slice(0, 10)) != null
          ),
          fragment = iface.getFunction(String(transaction.data).slice(0, 10)),
          answer = answers[`${to}:${fragment.name}`]
        expect(answer).toBeDefined()
        return iface.encodeFunctionResult(fragment, answer)
      }
    } as unknown as ethers.ContractRunner
  }

  /** A context over the staged tree, reading through `runner`. */
  function context(
    runner: ethers.ContractRunner = answeringRunner({})
  ): Parameters<typeof EthereumSyndicationTool.readPaused>[0] {
    return {
      config: { ethereumPath, dataPath },
      ethereum: { provider: runner }
    } as unknown as Parameters<typeof EthereumSyndicationTool.readPaused>[0]
  }

  beforeAll(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-syndication-"))
    ethereumPath = Path.join(root, "wire-ethereum")
    dataPath = Path.join(root, "data")
    stageArtifact(
      ethereumPath,
      EthereumSyndicationTool.SyndicationPoolArtifactSubpath,
      EthereumSyndicationTool.SyndicationPoolContractName,
      fixture(SyndicationPoolFixture)
    )
    stageArtifact(
      ethereumPath,
      EthereumSyndicationTool.DepositManagerArtifactSubpath,
      EthereumSyndicationTool.DepositManagerContractName,
      fixture(DepositManagerFixture)
    )
    stageArtifact(
      ethereumPath,
      EthereumSyndicationTool.LiqEthTokenArtifactSubpath,
      EthereumSyndicationTool.LiqEthTokenContractName,
      fixture(LiqEthTokenFixture),
      EthereumSyndicationTool.LiqEthTokenSourceName
    )
    stageArtifact(
      ethereumPath,
      EthereumSyndicationTool.OutpostManagerAuthorityArtifactSubpath,
      EthereumSyndicationTool.OutpostManagerAuthorityContractName,
      fixture(OutpostManagerAuthorityFixture)
    )
    stageArtifact(ethereumPath, EthereumOutpostBootstrapper.OutpostArtifactSubpath,
      EthereumOutpostBootstrapper.OutpostManagerArtifactName, fixture(OutpostManagerFixture), EthereumOutpostBootstrapper.OutpostManagerContractName)
    const deployments = Path.join(dataPath, "ethereum-deployments")
    Fs.mkdirSync(deployments, { recursive: true })
    Fs.writeFileSync(
      Path.join(deployments, EthereumOutpostBootstrapper.OutpostAddressesFile),
      JSON.stringify({
        SyndicationPool: PoolAddress,
        OutpostManager: ManagerAddress,
        OutpostManagerAuthority: AccessManagerAddress
      })
    )
    Fs.writeFileSync(
      Path.join(deployments, EthereumOutpostBootstrapper.LiqEthAddressesFile),
      JSON.stringify({
        DepositManager: DepositManagerAddress,
        LiqEthToken: LiqEthAddress
      })
    )
  })

  afterAll(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  describe("request builders", () => {
    const runner = () => answeringRunner({})

    it("encodes syndicate(amount, compressedPubkey) to the pool", () => {
      const pool = EthereumSyndicationTool.loadSyndicationPool(context(), runner()),
        key = EthereumSyndicationTool.compressedPubkey(HolderIndex),
        request = EthereumSyndicationTool.syndicateRequest(pool, 5n * 10n ** 18n, key)
      expect(request.to).toBe(PoolAddress)
      expect(String(request.data).slice(0, 10)).toBe(
        selector("syndicate(uint256,bytes)")
      )
      const [amount, pubkey] = poolInterface.decodeFunctionData(
        "syndicate",
        String(request.data)
      )
      expect(amount).toBe(5n * 10n ** 18n)
      expect(pubkey).toBe(key)
      expect(request.value).toBeUndefined()
    })

    it("encodes pause() and unpause() with no arguments", () => {
      const pool = EthereumSyndicationTool.loadSyndicationPool(context(), runner())
      expect(EthereumSyndicationTool.setPausedRequest(pool, true)).toEqual({
        to: PoolAddress,
        data: selector("pause()")
      })
      expect(EthereumSyndicationTool.setPausedRequest(pool, false)).toEqual({
        to: PoolAddress,
        data: selector("unpause()")
      })
    })

    it("encodes payPendingDesyndication(requestId) as a uint64", () => {
      const pool = EthereumSyndicationTool.loadSyndicationPool(context(), runner()),
        request = EthereumSyndicationTool.payPendingDesyndicationRequest(pool, 42n)
      expect(request.to).toBe(PoolAddress)
      expect(String(request.data).slice(0, 10)).toBe(
        selector("payPendingDesyndication(uint64)")
      )
      expect(
        poolInterface.decodeFunctionData("payPendingDesyndication", String(request.data))[0]
      ).toBe(42n)
    })

    it("encodes deposit() to the deposit manager with the value attached", () => {
      const depositManager = EthereumSyndicationTool.loadDepositManager(
        context(),
        runner()
      )
      expect(
        EthereumSyndicationTool.depositLiqEthRequest(depositManager, 3n * 10n ** 18n)
      ).toEqual({
        to: DepositManagerAddress,
        data: selector("deposit()"),
        value: 3n * 10n ** 18n
      })
    })

    it("encodes the liqETH approve and the donation transfer to the pool", () => {
      const liqEth = EthereumSyndicationTool.loadLiqEthToken(context(), runner()),
        approve = EthereumSyndicationTool.approveLiqEthRequest(liqEth, PoolAddress, 7n),
        donate = EthereumSyndicationTool.donateToPoolRequest(liqEth, PoolAddress, 9n)
      expect(approve.to).toBe(LiqEthAddress)
      expect(String(approve.data).slice(0, 10)).toBe(selector("approve(address,uint256)"))
      expect([...liqEthInterface.decodeFunctionData("approve", String(approve.data))]).toEqual([
        ethers.getAddress(PoolAddress),
        7n
      ])
      expect(donate.to).toBe(LiqEthAddress)
      expect(String(donate.data).slice(0, 10)).toBe(selector("transfer(address,uint256)"))
      expect([...liqEthInterface.decodeFunctionData("transfer", String(donate.data))]).toEqual([
        ethers.getAddress(PoolAddress),
        9n
      ])
    })
  })

  describe("loaders", () => {
    it("refuses when the outpost was never deployed", () => {
      const empty = {
        config: { ethereumPath, dataPath: Path.join(root, "missing") },
        ethereum: { provider: answeringRunner({}) }
      } as unknown as Parameters<typeof EthereumSyndicationTool.readPaused>[0]
      expect(() =>
        EthereumSyndicationTool.loadSyndicationPool(empty, answeringRunner({}))
      ).toThrow(/outpost-addrs\.json is missing/)
    })

    it("refuses when the address map carries no liqETH token", () => {
      const bare = Path.join(root, "bare"),
        deployments = Path.join(bare, "ethereum-deployments")
      Fs.mkdirSync(deployments, { recursive: true })
      Fs.writeFileSync(
        Path.join(deployments, EthereumOutpostBootstrapper.LiqEthAddressesFile),
        JSON.stringify({ DepositManager: DepositManagerAddress })
      )
      const noToken = {
        config: { ethereumPath, dataPath: bare },
        ethereum: { provider: answeringRunner({}) }
      } as unknown as Parameters<typeof EthereumSyndicationTool.readPaused>[0]
      expect(() =>
        EthereumSyndicationTool.loadLiqEthToken(noToken, answeringRunner({}))
      ).toThrow(/LiqEthToken not in outpost-addrs\.json/)
    })

    it("loads the liqETH token and the access manager from their artifacts", () => {
      const runner = answeringRunner({})
      expect(
        EthereumSyndicationTool.loadLiqEthToken(context(), runner).target
      ).toBe(LiqEthAddress)
      expect(
        EthereumSyndicationTool.loadOutpostManagerAuthority(context(), runner)
          .target
      ).toBe(AccessManagerAddress)
    })
  })

  describe("reads", () => {
    const pool = PoolAddress.toLowerCase(),
      token = LiqEthAddress.toLowerCase(),
      manager = AccessManagerAddress.toLowerCase()

    it("readPaused and readPoolBalanceDepot read the pool's views", async () => {
      const ctx = context(
        answeringRunner({
          [`${pool}:paused`]: [true],
          [`${pool}:poolBalanceDepot`]: [123_000_000_000n]
        })
      )
      await expect(EthereumSyndicationTool.readPaused(ctx)).resolves.toBe(true)
      await expect(EthereumSyndicationTool.readPoolBalanceDepot(ctx)).resolves.toBe(
        123_000_000_000n
      )
    })

    it("readPendingDesyndication decodes a stored release", async () => {
      const recipient = EthereumOutpostBootstrapper.anvilWallet(HolderIndex).address,
        ctx = context(
          answeringRunner({
            [`${pool}:pendingDesyndications`]: [
              recipient,
              5_000_000_000n,
              EthereumSyndicationTool.PendingPayoutReason.CUSTODY_SHORTFALL
            ]
          })
        )
      await expect(
        EthereumSyndicationTool.readPendingDesyndication(ctx, 11n)
      ).resolves.toEqual({
        recipient,
        depotAmount: 5_000_000_000n,
        reason: EthereumSyndicationTool.PendingPayoutReason.CUSTODY_SHORTFALL
      })
    })

    it("readPendingDesyndication returns undefined for an id with nothing stored", async () => {
      const ctx = context(
        answeringRunner({
          [`${pool}:pendingDesyndications`]: [ethers.ZeroAddress, 0n, 0n]
        })
      )
      await expect(
        EthereumSyndicationTool.readPendingDesyndication(ctx, 11n)
      ).resolves.toBeUndefined()
    })

    it("readLiqEthBalance reads the token balance of an account", async () => {
      const holder = EthereumOutpostBootstrapper.anvilWallet(HolderIndex).address
      await expect(
        EthereumSyndicationTool.readLiqEthBalance(
          context(answeringRunner({ [`${token}:balanceOf`]: [77n] })),
          holder
        )
      ).resolves.toBe(77n)
    })

    it("readPoolConfiguration reads the four configured values", async () => {
      await expect(
        EthereumSyndicationTool.readPoolConfiguration(
          context(
            answeringRunner({
              [`${pool}:maxSyndicationPerTransfer`]: [10n ** 21n],
              [`${pool}:yieldDeadband`]: [10_000_000n],
              [`${pool}:liqTokenCode`]: [EthereumSyndicationTool.liqEthTokenCode()],
              [`${pool}:liqTokenPrecision`]: [18]
            })
          )
        )
      ).resolves.toEqual({
        maxSyndicationPerTransfer: 10n ** 21n,
        yieldDeadband: 10_000_000n,
        liqTokenCode: EthereumSyndicationTool.liqEthTokenCode(),
        liqTokenPrecision: 18
      })
    })

    it("readCanCallPool asks the pool's own access manager about the selector", async () => {
      const calls: string[] = [],
        base = answeringRunner({
          [`${pool}:authority`]: [AccessManagerAddress],
          [`${manager}:canCall`]: [true, 0]
        }),
        recording = {
          provider: null,
          call: async (transaction: ethers.TransactionRequest) => {
            calls.push(String(transaction.data))
            return base.call(transaction)
          }
        } as unknown as ethers.ContractRunner,
        panic = EthereumOutpostBootstrapper.anvilWallet(
          EthereumOutpostBootstrapper.PanicAccountIndex
        ).address
      await expect(
        EthereumSyndicationTool.readCanCallPool(
          context(recording),
          panic,
          EthereumSyndicationTool.PoolFunction.pause
        )
      ).resolves.toBe(true)
      const [caller, target, asked] = accessManagerInterface.decodeFunctionData(
        "canCall",
        calls.find(data => data.startsWith(selector("canCall(address,address,bytes4)")))
      )
      expect([caller, target, asked]).toEqual([
        panic,
        ethers.getAddress(PoolAddress),
        selector("pause()")
      ])
    })

    it("readCanCallPool refuses a pool that answers to another manager", async () => {
      await expect(
        EthereumSyndicationTool.readCanCallPool(
          context(
            answeringRunner({
              [`${pool}:authority`]: [DepositManagerAddress],
              [`${manager}:canCall`]: [true, 0]
            })
          ),
          ethers.ZeroAddress,
          EthereumSyndicationTool.PoolFunction.pause
        )
      ).rejects.toThrow(/not the deployed OutpostManagerAuthority/)
    })

    it("readCanCallPool reports a caller the manager refuses", async () => {
      await expect(
        EthereumSyndicationTool.readCanCallPool(
          context(
            answeringRunner({
              [`${pool}:authority`]: [AccessManagerAddress],
              [`${manager}:canCall`]: [false, 0]
            })
          ),
          ethers.ZeroAddress,
          EthereumSyndicationTool.PoolFunction.unpause
        )
      ).resolves.toBe(false)
    })
  })

  describe("value helpers", () => {
    it("derives a compressed key that recovers to the holder's address", () => {
      const key = EthereumSyndicationTool.compressedPubkey(HolderIndex)
      expect(ethers.getBytes(key)).toHaveLength(33)
      expect(ethers.computeAddress(key)).toBe(
        EthereumOutpostBootstrapper.anvilWallet(HolderIndex).address
      )
    })

    it("names LIQETH as the pool's token code, at 18 decimals", () => {
      expect(EthereumSyndicationTool.liqEthTokenCode()).toBe(53_413_376_196_608n)
      expect(EthereumSyndicationTool.LiqEthTokenPrecision).toBe(18)
    })

    it("pins the ordinals of SyndicationPool.PendingPayoutReason (d4fbb8f8)", () => {
      // A PIN, not a derivation: the ABI carries the enum only as a uint8, so
      // the order is copied from `SyndicationPool.sol` and fails here when the
      // contract appends a reason this enum does not know.
      const [, , reason] = poolInterface.getFunction("pendingDesyndications").outputs
      expect(reason.type).toBe("uint8")
      expect(EthereumSyndicationTool.PendingPayoutReason.OUTPOST_FROZEN).toBe(0)
      expect(EthereumSyndicationTool.PendingPayoutReason.SETTLEMENT_REFUSED).toBe(1)
      expect(EthereumSyndicationTool.PendingPayoutReason.CUSTODY_SHORTFALL).toBe(2)
    })
  })

  describe("step factories", () => {
    it("carries each holder write's HD index and amount, with its named runner", () => {
      const cases = [
        {
          step: EthereumSyndicationTool.planDepositLiqEth(
            Report.Actor.User, "deposit", "deposit ETH", {}, HolderIndex, 4n
          ),
          input: { kind: "EthereumSyndicationTool.DepositLiqEthInput", ethereumHdIndex: HolderIndex, amountWei: 4n },
          runner: EthereumSyndicationTool.runDepositLiqEth
        },
        {
          step: EthereumSyndicationTool.planApproveLiqEth(
            Report.Actor.User, "approve", "approve the pool", {}, HolderIndex, 4n
          ),
          input: { kind: "EthereumSyndicationTool.ApproveLiqEthInput", ethereumHdIndex: HolderIndex, amount: 4n },
          runner: EthereumSyndicationTool.runApproveLiqEth
        },
        {
          step: EthereumSyndicationTool.planDonateToPool(
            Report.Actor.User, "donate", "donate liqETH", {}, HolderIndex, 4n
          ),
          input: { kind: "EthereumSyndicationTool.DonateToPoolInput", ethereumHdIndex: HolderIndex, amount: 4n },
          runner: EthereumSyndicationTool.runDonateToPool
        },
        {
          step: EthereumSyndicationTool.planPayPendingDesyndication(
            Report.Actor.User, "pay", "pay the stored release", {}, HolderIndex, 9n
          ),
          input: {
            kind: "EthereumSyndicationTool.PayPendingDesyndicationInput",
            ethereumHdIndex: HolderIndex,
            requestId: 9n
          },
          runner: EthereumSyndicationTool.runPayPendingDesyndication
        }
      ]
      cases.forEach(({ step, input, runner }) => {
        expect(step.input).toEqual(input)
        expect(step.runner).toBe(runner)
      })
    })

    it("planSyndicate carries the compressed key as given", () => {
      const key = EthereumSyndicationTool.compressedPubkey(HolderIndex),
        step = EthereumSyndicationTool.planSyndicate(
          Report.Actor.User, "syndicate", "syndicate liqETH", {}, HolderIndex, 4n, key
        )
      expect(step.input).toEqual({
        kind: "EthereumSyndicationTool.SyndicateInput",
        ethereumHdIndex: HolderIndex,
        amount: 4n,
        compressedPubkey: key
      })
      expect(step.runner).toBe(EthereumSyndicationTool.runSyndicate)
    })

    it("planSetPaused names the panic account as its signer, both ways", () => {
      const pause = EthereumSyndicationTool.planSetPaused(
          Report.Actor.EthereumOutpost, "pause", "pull the stop", {}, true
        ),
        unpause = EthereumSyndicationTool.planSetPaused(
          Report.Actor.EthereumOutpost, "unpause", "clear the stop", {}, false
        )
      expect(pause.input).toEqual({
        kind: "EthereumSyndicationTool.SetPausedInput",
        ethereumHdIndex: EthereumOutpostBootstrapper.PanicAccountIndex,
        paused: true
      })
      expect(unpause.input.paused).toBe(false)
      expect(unpause.input.ethereumHdIndex).toBe(
        EthereumOutpostBootstrapper.PanicAccountIndex
      )
      expect(pause.runner).toBe(EthereumSyndicationTool.runSetPaused)
    })
  })

  it("seeds depot principal through the manager in one transaction and preserves current configuration", async () => {
    const pool = PoolAddress.toLowerCase(),
      chainCode = 123n, tokenCode = 456n, precision = 18n, deadband = 7n,
      initialPrincipal = 110_000_000_000n,
      reader = answeringRunner({
        [`${pool}:outpostChainCode`]: [chainCode],
        [`${pool}:liqTokenCode`]: [tokenCode],
        [`${pool}:liqTokenPrecision`]: [precision],
        [`${pool}:yieldDeadband`]: [deadband],
        [`${pool}:syndicatedPrincipal`]: [initialPrincipal]
      }),
      wait = jest.fn().mockResolvedValue({ status: 1 }),
      sendTransaction = jest.fn().mockResolvedValue({ wait }),
      signer = {
        call: reader.call,
        provider: { getTransactionCount: jest.fn().mockResolvedValue(0) },
        getAddress: async () => ManagerAddress,
        sendTransaction
      },
      connect = jest.fn().mockReturnValue(signer),
      wallet = jest.spyOn(EthereumOutpostBootstrapper, "anvilWallet").mockReturnValue({ connect } as unknown as ethers.HDNodeWallet),
      step = EthereumSyndicationTool.planInitializeSyndication(Report.Actor.EthereumOutpost,
        "initialize", "seed principal", {}, EthereumOutpostBootstrapper.DeployerAccountIndex, initialPrincipal)
    try {
      await step.runner(context(reader), step.input, new AbortController().signal)
      expect(wallet).toHaveBeenCalledWith(EthereumOutpostBootstrapper.DeployerAccountIndex)
      expect(sendTransaction).toHaveBeenCalledTimes(1)
      const request = sendTransaction.mock.calls[0][0],
        managerInterface = new ethers.Interface(fixture(OutpostManagerFixture).abi),
        [target, data] = managerInterface.decodeFunctionData("execute", request.data)
      expect(String(request.to).toLowerCase()).toBe(ManagerAddress)
      expect(String(target).toLowerCase()).toBe(pool)
      expect(poolInterface.decodeFunctionData("initializeSyndication", data).toArray()).toEqual([
        chainCode, tokenCode, precision, deadband, initialPrincipal
      ])
      expect(wait).toHaveBeenCalledWith(EthereumSyndicationTool.Confirmations)
      await expect(EthereumSyndicationTool.readSyndicatedPrincipal(context(reader))).resolves.toBe(initialPrincipal)
    } finally {
      wallet.mockRestore()
    }
  })

  describe("runner input guards", () => {
    const signal = new AbortController().signal

    it("runDepositLiqEth rejects a non-positive deposit", async () => {
      await expect(
        EthereumSyndicationTool.runDepositLiqEth(
          context(),
          { kind: "EthereumSyndicationTool.DepositLiqEthInput", ethereumHdIndex: HolderIndex, amountWei: 0n },
          signal
        )
      ).rejects.toThrow(/amountWei must be positive/)
    })

    it("runSyndicate rejects a non-positive amount", async () => {
      await expect(
        EthereumSyndicationTool.runSyndicate(
          context(),
          {
            kind: "EthereumSyndicationTool.SyndicateInput",
            ethereumHdIndex: HolderIndex,
            amount: 0n,
            compressedPubkey: EthereumSyndicationTool.compressedPubkey(HolderIndex)
          },
          signal
        )
      ).rejects.toThrow(/amount must be positive/)
    })

    it("runDonateToPool rejects a non-positive amount", async () => {
      await expect(
        EthereumSyndicationTool.runDonateToPool(
          context(),
          { kind: "EthereumSyndicationTool.DonateToPoolInput", ethereumHdIndex: HolderIndex, amount: 0n },
          signal
        )
      ).rejects.toThrow(/amount must be positive/)
    })

    it("every runner honours an aborted signal before touching the chain", async () => {
      const aborted = AbortSignal.abort()
      await expect(
        EthereumSyndicationTool.runSetPaused(
          context(),
          {
            kind: "EthereumSyndicationTool.SetPausedInput",
            ethereumHdIndex: EthereumOutpostBootstrapper.PanicAccountIndex,
            paused: true
          },
          aborted
        )
      ).rejects.toThrow()
      await expect(
        EthereumSyndicationTool.runApproveLiqEth(
          context(),
          { kind: "EthereumSyndicationTool.ApproveLiqEthInput", ethereumHdIndex: HolderIndex, amount: 1n },
          aborted
        )
      ).rejects.toThrow()
      await expect(
        EthereumSyndicationTool.runPayPendingDesyndication(
          context(),
          {
            kind: "EthereumSyndicationTool.PayPendingDesyndicationInput",
            ethereumHdIndex: HolderIndex,
            requestId: 1n
          },
          aborted
        )
      ).rejects.toThrow()
    })
  })
})
