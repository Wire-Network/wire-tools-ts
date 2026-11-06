import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { EthereumOutpostBootstrapper, Steps } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { EthereumSyndicationTool } from "@wireio/cluster-tool/tools/ethereum"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"

/**
 * The `SyndicationPool` and `DepositManager` ABIs, TRIMMED from wire-ethereum's
 * hardhat artifacts (feature/syndication-underwriting d4fbb8f8, whose compiled
 * sources match that commit) to the functions this tool calls. Staged into a
 * fake `artifacts/` tree so the tool's own loaders read them, exactly as they
 * read the real ones at run time. Custody allowance and check events are trimmed
 * from the declarations in Ethereum PR #271 (0c777d53).
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

/** Gross fixture return and its exact net under the bootstrap's Ethereum fee. */
const GrossReturn = 500_000_000n,
  NetReturn = GrossReturn - WireSyndicationTool.feeOf(
    GrossReturn,
    Steps.registry.DesyndicationFeeBps,
    BigInt(Steps.registry.DesyndicationFlatFees.LIQETH)
  )

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

    it.each([0n, 100n, 250n, 1000n])(
      "reads the deployed custody allowance: %s",
      async allowance => {
        const ctx = context(
          answeringRunner({ [`${pool}:custodyShortfallBps`]: [allowance] })
        )
        await expect(
          EthereumSyndicationTool.readCustodyShortfallBps(ctx)
        ).resolves.toBe(allowance)
      }
    )

    it("propagates a custody allowance RPC failure", async () => {
      const ctx = context({
        provider: null,
        call: async () => {
          throw new Error("custody RPC failed")
        }
      })
      await expect(
        EthereumSyndicationTool.readCustodyShortfallBps(ctx)
      ).rejects.toThrow("custody RPC failed")
    })

    describe("readCustodyCheck", () => {
      /** Real ABI-encoded check logs; tolerated and refused events use different custody frames. */
      function checkLog(
        tolerated: boolean,
        requestId = 23n,
        custody = 9900n
      ): ethers.Log {
        const name = tolerated
            ? "CustodyShortfallTolerated"
            : "CustodyShortfall",
          values = tolerated
            ? [requestId, custody, 10_000n, 100n]
            : [requestId, custody, 10_000n],
          { data, topics } = poolInterface.encodeEventLog(name, values)
        return new ethers.Log(
          {
            address: PoolAddress,
            blockHash: ethers.ZeroHash,
            blockNumber: 120,
            transactionHash: ethers.ZeroHash,
            transactionIndex: 3,
            index: 0,
            removed: false,
            data,
            topics
          },
          null
        )
      }

      /** A provider with independent log and receipt evidence and a live allowance getter. */
      function checkContext(logs: ethers.Log[], status = 1) {
        const base = answeringRunner({
            [`${pool}:custodyShortfallBps`]: [100n]
          }),
          provider = {
            getLogs: async () =>
              logs.map(
                log =>
                  new ethers.Log(log, provider as unknown as ethers.Provider)
              ),
            getTransactionReceipt: async () => ({
              status,
              blockHash: ethers.ZeroHash
            })
          }
        return context({
          call: base.call,
          provider
        } as unknown as ethers.ContractRunner)
      }

      it.each([true, false])(
        "normalizes actual custody for tolerated=%s",
        async tolerated => {
          await expect(
            EthereumSyndicationTool.readCustodyCheck(
              checkContext([checkLog(tolerated), checkLog(tolerated, 24n)]),
              23n,
              500n,
              tolerated
            )
          ).resolves.toEqual({
            requestId: 23n,
            postPayoutBalanceDepot: tolerated ? 9900n : 9400n,
            totalSyndicated: 10_000n,
            toleranceBps: 100n
          })
        }
      )

      it("returns undefined while the request's check has not arrived", async () => {
        await expect(
          EthereumSyndicationTool.readCustodyCheck(
            checkContext([checkLog(true, 24n)]),
            23n,
            500n,
            true
          )
        ).resolves.toBeUndefined()
      })

      it("rejects duplicate checks and failed receipts", async () => {
        await expect(
          EthereumSyndicationTool.readCustodyCheck(
            checkContext([checkLog(true), checkLog(true)]),
            23n,
            500n,
            true
          )
        ).rejects.toThrow("exactly one")
        await expect(
          EthereumSyndicationTool.readCustodyCheck(
            checkContext([checkLog(true)], 0),
            23n,
            500n,
            true
          )
        ).rejects.toThrow("successful receipt")
      })

      it("rejects an unfunded payout even when the pool reports a shortfall", async () => {
        await expect(
          EthereumSyndicationTool.readCustodyCheck(
            checkContext([checkLog(false, 23n, 499n)]),
            23n,
            500n,
            false
          )
        ).rejects.toThrow("fully fund")
      })
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

    it("readLiqEthBalance and readLiqEthRate read at the requested block", async () => {
      const blockTags: ethers.BlockTag[] = [],
        base = answeringRunner({
          [`${token}:balanceOf`]: [78n],
          [`${token}:index`]: [3n * 10n ** 17n + 10n ** 18n],
          [`${token}:unit`]: [10n ** 18n]
        }),
        recording = {
          provider: null,
          call: async (transaction: ethers.TransactionRequest) => {
            blockTags.push(transaction.blockTag)
            return base.call(transaction)
          }
        } as unknown as ethers.ContractRunner,
        holder = EthereumOutpostBootstrapper.anvilWallet(HolderIndex).address
      await expect(
        EthereumSyndicationTool.readLiqEthBalance(context(recording), holder, 41)
      ).resolves.toBe(78n)
      await expect(
        EthereumSyndicationTool.readLiqEthRate(context(recording), 41)
      ).resolves.toEqual({ index: 13n * 10n ** 17n, unit: 10n ** 18n })
      expect(blockTags).toEqual([41, 41, 41])
    })

    describe("readDesyndicationPayment", () => {
      const holder = EthereumOutpostBootstrapper.anvilWallet(HolderIndex).address

      /** A `Desyndicated` log as the provider returns it, encoded by the pool ABI. */
      function desyndicatedLog(
        requestId: bigint,
        blockNumber: number,
        transactionIndex: number
      ): ethers.Log {
        const { data, topics } = poolInterface.encodeEventLog("Desyndicated", [
          holder,
          NetReturn * 10n ** 9n,
          NetReturn,
          requestId
        ])
        return {
          address: ethers.getAddress(PoolAddress),
          blockHash: ethers.ZeroHash,
          blockNumber,
          data,
          topics,
          index: 0,
          removed: false,
          transactionHash: ethers.ZeroHash,
          transactionIndex
        } as unknown as ethers.Log
      }

      /** A runner whose provider answers `getLogs` with `logs`, recording each filter. */
      function loggingRunner(
        logs: ReadonlyArray<ethers.Log>,
        filters: ethers.Filter[] = [],
        receiptLogs: ReadonlyArray<ethers.Log> = [transferLog()],
        status = 1
      ): ethers.ContractRunner {
        const provider = {
          getLogs: async (filter: ethers.Filter) => {
            filters.push(filter)
            return logs.map(log => new ethers.Log(log, provider as unknown as ethers.Provider))
          },
          getTransactionReceipt: async () => ({ status, blockHash: ethers.ZeroHash, logs: receiptLogs })
        }
        return { provider } as unknown as ethers.ContractRunner
      }

      /** A real ABI-encoded token transfer, independent of the pool event. */
      function transferLog(
        from = PoolAddress,
        to = holder,
        value = NetReturn * 10n ** 9n,
        address = LiqEthAddress
      ): ethers.Log {
        const { data, topics } = liqEthInterface.encodeEventLog(
          EthereumSyndicationTool.LiqEthEvent.Transfer, [from, to, value]
        )
        return new ethers.Log({
          address: ethers.getAddress(address), data, topics,
          blockHash: ethers.ZeroHash, blockNumber: 120,
          transactionHash: ethers.ZeroHash, transactionIndex: 1, index: 0,
          removed: false
        }, null)
      }

      it("verifies a transfer in a later transaction of a shared block", async () => {
        const payment = await EthereumSyndicationTool.readDesyndicationPayment(
          context(loggingRunner([desyndicatedLog(7n, 120, 3)])), 7n
        )
        expect(payment.transactionIndex).toBe(3)
        expect(payment.nativeAmount).toBe(NetReturn * 10n ** 9n)
      })

      it.each([
        ["missing", []],
        ["duplicate", [transferLog(), transferLog()]],
        ["wrong sender", [transferLog(holder)]],
        ["wrong recipient", [transferLog(PoolAddress, PoolAddress)]],
        ["wrong amount", [transferLog(PoolAddress, holder, 1n)]],
        ["wrong token", [transferLog(PoolAddress, holder, NetReturn * 10n ** 9n, PoolAddress)]]
      ])("refuses a %s receipt transfer", async (_label, receiptLogs) => {
        await expect(EthereumSyndicationTool.readDesyndicationPayment(
          context(loggingRunner([desyndicatedLog(7n, 120, 1)], [], receiptLogs)), 7n
        )).rejects.toThrow(/expected exactly one matching liqETH transfer/)
      })

      it("refuses an unsuccessful payment receipt", async () => {
        await expect(EthereumSyndicationTool.readDesyndicationPayment(
          context(loggingRunner([desyndicatedLog(7n, 120, 1)], [], [transferLog()], 0)), 7n
        )).rejects.toThrow(/no successful receipt/)
      })

      it("returns the one payment for the request, scanning the pool from genesis", async () => {
        const filters: ethers.Filter[] = []
        await expect(
          EthereumSyndicationTool.readDesyndicationPayment(
            context(
              loggingRunner(
                [desyndicatedLog(6n, 90, 0), desyndicatedLog(7n, 120, 0)],
                filters
              )
            ),
            7n
          )
        ).resolves.toEqual({
          recipient: holder,
          nativeAmount: NetReturn * 10n ** 9n,
          depotAmount: NetReturn,
          requestId: 7n,
          blockNumber: 120,
          transactionIndex: 0
        })
        expect(filters).toHaveLength(1)
        expect(filters[0].address).toBe(PoolAddress)
        expect(filters[0].fromBlock).toBe(EthereumSyndicationTool.EventScanFromBlock)
        expect(filters[0].topics[0]).toBe(
          poolInterface.getEvent("Desyndicated").topicHash
        )
      })

      it("refuses a request the pool never paid", async () => {
        await expect(
          EthereumSyndicationTool.readDesyndicationPayment(
            context(loggingRunner([desyndicatedLog(6n, 90, 0)])),
            7n
          )
        ).rejects.toThrow(/expected exactly one Desyndicated event for request 7, found 0/)
      })

      it("refuses a request the pool paid twice", async () => {
        await expect(
          EthereumSyndicationTool.readDesyndicationPayment(
            context(
              loggingRunner([desyndicatedLog(7n, 120, 0), desyndicatedLog(7n, 121, 1)])
            ),
            7n
          )
        ).rejects.toThrow(/expected exactly one Desyndicated event for request 7, found 2/)
      })
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

    describe("liqEthBalanceAfterTransfer", () => {
      /** 1.5 wei per share: shares 2 → balance 3. */
      const rate = { index: 3n, unit: 2n }

      it("credits the ceil-rounded shares, which can exceed balance + value", () => {
        // ceil(2·2/3) = 2 shares added to 2 → floor(4·3/2) = 6 = 3 + 2 + 1.
        expect(EthereumSyndicationTool.liqEthBalanceAfterTransfer(3n, 2n, rate)).toBe(6n)
        // ceil(1·2/3) = 1 share added to 2 → floor(3·3/2) = 4 = 3 + 1.
        expect(EthereumSyndicationTool.liqEthBalanceAfterTransfer(3n, 1n, rate)).toBe(4n)
      })

      it("is plain addition at an index equal to its unit", () => {
        expect(
          EthereumSyndicationTool.liqEthBalanceAfterTransfer(
            999_500_000_000_000_000n,
            499_750_000_000_000_000n,
            { index: 10n ** 18n, unit: 10n ** 18n }
          )
        ).toBe(1_499_250_000_000_000_000n)
      })

      it("refuses an index below its unit", () => {
        expect(() =>
          EthereumSyndicationTool.liqEthBalanceAfterTransfer(3n, 2n, { index: 1n, unit: 2n })
        ).toThrow(/index 1 below its unit 2/)
      })

      it("refuses a balance no share count produces", () => {
        expect(() =>
          EthereumSyndicationTool.liqEthBalanceAfterTransfer(2n, 2n, rate)
        ).toThrow(/no share count yields balance 2 at index 3\/2/)
      })
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
          Report.Actor.User, "syndicate", "syndicate liqETH", {}, HolderIndex, 5_000_000_000_000_000n, key
        )
      expect(step.input).toEqual({
        kind: "EthereumSyndicationTool.SyndicateInput",
        ethereumHdIndex: HolderIndex,
        amount: 5_000_000_000_000_000n,
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
