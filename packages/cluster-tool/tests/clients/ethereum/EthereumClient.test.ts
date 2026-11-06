import { ethers } from "ethers"
import { match } from "ts-pattern"

import { EthereumClient } from "@wireio/cluster-tool/clients/ethereum"
import { AnvilProcess } from "@wireio/cluster-tool/cluster/processes"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { StepExtraRecorder } from "@wireio/cluster-tool/report/tools"
import { toURL } from "@wireio/cluster-tool/utils"

/** Minimal ABI carrying the one event `getOPPEnvelopes` filters on. */
const OppEnvelopeAbi = [
  `event ${EthereumClient.OppEnvelopeEvent}(bytes data)`
] as const

describe("EthereumClient", () => {
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    )
  })

  it("derives a deterministic signer address from the default key", () => {
    const a = new EthereumClient(rpcUrl)
    const b = new EthereumClient(rpcUrl)
    expect(a.wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(b.wallet.address).toBe(a.wallet.address)
  })

  it("matches the default-key address when the key is supplied explicitly", () => {
    const implicit = new EthereumClient(rpcUrl)
    const explicit = new EthereumClient(
      rpcUrl,
      EthereumClient.DefaultPrivateKey
    )
    expect(explicit.wallet.address).toBe(implicit.wallet.address)
  })

  describe("getContract", () => {
    it("caches by (name, address)", () => {
      const client = new EthereumClient(rpcUrl)
      const first = client.getContract("Foo", ethers.ZeroAddress, [])
      const again = client.getContract("Foo", ethers.ZeroAddress, [])
      expect(again).toBe(first)
    })

    it("re-binds the same name at a different address", () => {
      const client = new EthereumClient(rpcUrl)
      const otherAddress = new ethers.Wallet(EthereumClient.DefaultPrivateKey)
        .address
      const a = client.getContract("Foo", ethers.ZeroAddress, [])
      const b = client.getContract("Foo", otherAddress, [])
      expect(b).not.toBe(a)
    })
  })

  describe("state changes inside the ethers cache window", () => {
    const GasEstimate = 21_000n,
      TransactionHash = `0x${"01".repeat(32)}`,
      BlockHash = `0x${"02".repeat(32)}`,
      PoolAddress = "0x0000000000000000000000000000000000000010",
      PoolInterface = new ethers.Interface([
        "error EnforcedPause()",
        "function unpause()",
        "function payPendingDesyndication(uint64 requestId)"
      ])

    let client: EthereumClient,
      send: jest.SpyInstance,
      paused: boolean,
      pausedError: ethers.CallExceptionError

    beforeEach(() => {
      jest.useFakeTimers()
      client = new EthereumClient(rpcUrl)
      paused = true
      pausedError = ethers.makeError(
        "execution reverted: EnforcedPause()",
        "CALL_EXCEPTION",
        {
          action: "estimateGas",
          data: PoolInterface.encodeErrorResult("EnforcedPause"),
          reason: "EnforcedPause()",
          invocation: null,
          revert: {
            name: "EnforcedPause",
            signature: "EnforcedPause()",
            args: []
          },
          transaction: { to: PoolAddress, data: createPaymentRequest().data }
        }
      )
      // Double only the RPC boundary. Ethers' public estimate/read methods,
      // request cache and the recording provider remain real.
      jest
        .spyOn(client.provider, "getNetwork")
        .mockResolvedValue(ethers.Network.from(AnvilProcess.DefaultChainId))
      send = jest
        .spyOn(ethers.JsonRpcProvider.prototype, "send")
        .mockImplementation(async method =>
          match(method)
            .with("eth_estimateGas", () => {
              if (paused) throw pausedError
              return ethers.toQuantity(GasEstimate)
            })
            .with("eth_sendTransaction", () => {
              paused = false
              return TransactionHash
            })
            .with("eth_getTransactionReceipt", () => ({
              transactionHash: TransactionHash,
              blockHash: BlockHash,
              blockNumber: "0x1",
              transactionIndex: "0x0",
              from: client.wallet.address,
              to: PoolAddress,
              gasUsed: ethers.toQuantity(GasEstimate),
              cumulativeGasUsed: ethers.toQuantity(GasEstimate),
              effectiveGasPrice: "0x1",
              logs: [],
              status: "0x1",
              type: "0x2"
            }))
            .otherwise(() => {
              throw new Error(`Unexpected RPC method: ${method}`)
            })
        )
    })

    afterEach(() => {
      client.provider.destroy()
      jest.restoreAllMocks()
      jest.useRealTimers()
    })

    function createPaymentRequest(): ethers.TransactionRequest {
      return {
        to: PoolAddress,
        data: PoolInterface.encodeFunctionData("payPendingDesyndication", [1n])
      }
    }

    it("estimates the identical payment again after a mined unpause and records both requests", async () => {
      const recorder = new StepExtraRecorder(),
        started = Date.now(),
        request = createPaymentRequest()

      await StepExtraRecorder.runWith(recorder, async () => {
        await expect(client.wallet.signer.estimateGas(request)).rejects.toBe(
          pausedError
        )
        const signer = new ethers.JsonRpcSigner(
            client.provider,
            client.wallet.address
          ),
          hash = await signer.sendUncheckedTransaction({
            to: PoolAddress,
            data: PoolInterface.encodeFunctionData("unpause"),
            gasLimit: GasEstimate
          }),
          receipt = await client.provider.getTransactionReceipt(hash)
        expect(receipt?.status).toBe(1)
        await expect(client.wallet.signer.estimateGas(request)).resolves.toBe(
          GasEstimate
        )
      })

      expect(Date.now()).toBe(started)
      const estimates = send.mock.calls.filter(
        ([method]) => method === "eth_estimateGas"
      )
      expect(estimates).toHaveLength(2)
      expect(estimates[1]).toEqual(estimates[0])
      expect(recorder.calls).toContainEqual(
        expect.objectContaining({
          method: "eth_estimateGas",
          count: 2
        })
      )
      expect(recorder.calls).toContainEqual(
        expect.objectContaining({
          method: "eth_sendTransaction",
          ok: true,
          result: TransactionHash
        })
      )
    })

    it("continues to refuse payment while paused without retrying or hiding the error", async () => {
      await expect(
        client.wallet.signer.estimateGas(createPaymentRequest())
      ).rejects.toBe(pausedError)
      await expect(
        client.wallet.signer.estimateGas(createPaymentRequest())
      ).rejects.toBe(pausedError)
      expect(send.mock.calls.map(([method]) => method)).toEqual([
        "eth_estimateGas",
        "eth_estimateGas"
      ])
    })

    it("propagates an unrelated RPC error without retrying", async () => {
      const error = new Error("RPC unavailable")
      send.mockRejectedValue(error)
      await expect(
        client.wallet.signer.estimateGas(createPaymentRequest())
      ).rejects.toBe(error)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it("does not reuse a successful estimate after the pool becomes paused", async () => {
      paused = false
      await expect(
        client.wallet.signer.estimateGas(createPaymentRequest())
      ).resolves.toBe(GasEstimate)
      paused = true
      await expect(
        client.wallet.signer.estimateGas(createPaymentRequest())
      ).rejects.toBe(pausedError)
      expect(send).toHaveBeenCalledTimes(2)
    })

    it("reads updated balances, block numbers and account nonces in the same tick", async () => {
      send.mockResolvedValue("0x1")
      await expect(client.getBalance(client.wallet.address)).resolves.toBe(1n)
      await expect(client.getBlockNumber()).resolves.toBe(1)
      await expect(
        client.provider.getTransactionCount(client.wallet.address)
      ).resolves.toBe(1)

      send.mockResolvedValue("0x2")
      await expect(client.getBalance(client.wallet.address)).resolves.toBe(2n)
      await expect(client.getBlockNumber()).resolves.toBe(2)
      await expect(
        client.provider.getTransactionCount(client.wallet.address)
      ).resolves.toBe(2)
      expect(send).toHaveBeenCalledTimes(6)
    })
  })

  describe("OPP events", () => {
    it("queries and filters the canonical OPPEnvelope event stream", async () => {
      const client = new EthereumClient(rpcUrl),
        // A REAL contract carrying the event, so `filters[OppEnvelopeEvent]()`
        // runs ethers' own topic machinery; only the network round-trip is
        // doubled.
        opp = client.getContract("Opp", ethers.ZeroAddress, OppEnvelopeAbi),
        envelopeEvent = Object.create(
          ethers.EventLog.prototype
        ) as ethers.EventLog,
        // A plain `Log` — the non-EventLog the filter must drop.
        unparsed = Object.create(ethers.Log.prototype) as ethers.Log,
        queryFilter = jest
          .spyOn(opp, "queryFilter")
          .mockResolvedValue([envelopeEvent, unparsed])

      await expect(client.getOPPEnvelopes(opp, 7)).resolves.toEqual([
        envelopeEvent
      ])
      expect(queryFilter).toHaveBeenCalledWith(
        await opp.filters[EthereumClient.OppEnvelopeEvent](),
        7
      )
    })

    it("propagates query failures and exposes no retired epoch helper", async () => {
      const client = new EthereumClient(rpcUrl),
        error = new Error("RPC unavailable"),
        opp = client.getContract("Opp", ethers.ZeroAddress, OppEnvelopeAbi)
      jest.spyOn(opp, "queryFilter").mockRejectedValue(error)

      await expect(client.getOPPEnvelopes(opp)).rejects.toBe(error)
      expect("getOPPEpochs" in client).toBe(false)
      expect("OppEpochEvent" in EthereumClient).toBe(false)
    })
  })
})
