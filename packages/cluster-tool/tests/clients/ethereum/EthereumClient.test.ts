import { ethers } from "ethers"
import { EthereumClient } from "@wireio/cluster-tool/clients/ethereum"
import { BindConfig } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

describe("EthereumClient", () => {
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(await BindConfig.findAvailable(BindConfig.DefaultAnvil))
  })

  it("derives a deterministic signer address from the default key", () => {
    const a = new EthereumClient(rpcUrl)
    const b = new EthereumClient(rpcUrl)
    expect(a.wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(b.wallet.address).toBe(a.wallet.address)
  })

  it("matches the default-key address when the key is supplied explicitly", () => {
    const implicit = new EthereumClient(rpcUrl)
    const explicit = new EthereumClient(rpcUrl, EthereumClient.DefaultPrivateKey)
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

  describe("OPP events", () => {
    it("queries and filters the canonical OPPEnvelope event stream", async () => {
      const client = new EthereumClient(rpcUrl)
      const filter = {}
      const envelopeEvent = Object.create(
        ethers.EventLog.prototype
      ) as ethers.EventLog
      const filters = {
        [EthereumClient.OppEnvelopeEvent]: jest.fn(() => filter)
      }
      const queryFilter = jest
        .fn()
        .mockResolvedValue([envelopeEvent, { eventName: "unparsed" }])
      const opp = { filters, queryFilter } as unknown as ethers.Contract

      await expect(client.getOPPEnvelopes(opp, 7)).resolves.toEqual([
        envelopeEvent
      ])
      expect(filters.OPPEnvelope).toHaveBeenCalledTimes(1)
      expect(queryFilter).toHaveBeenCalledWith(filter, 7)
    })

    it("propagates query failures and exposes no retired epoch helper", async () => {
      const client = new EthereumClient(rpcUrl)
      const error = new Error("RPC unavailable")
      const opp = {
        filters: {
          [EthereumClient.OppEnvelopeEvent]: jest.fn(() => ({}))
        },
        queryFilter: jest.fn().mockRejectedValue(error)
      } as unknown as ethers.Contract

      await expect(client.getOPPEnvelopes(opp)).rejects.toBe(error)
      expect("getOPPEpochs" in client).toBe(false)
      expect("OppEpochEvent" in EthereumClient).toBe(false)
    })
  })
})
