import { ethers } from "ethers"
import { EthereumClient } from "@wireio/cluster-tool/clients/ethereum"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

/** Minimal ABI carrying the one event `getOPPEnvelopes` filters on. */
const OppEnvelopeAbi = [`event ${EthereumClient.OppEnvelopeEvent}(bytes data)`] as const

describe("EthereumClient", () => {
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil))
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
      const otherAddress = new ethers.Wallet(EthereumClient.DefaultPrivateKey).address
      const a = client.getContract("Foo", ethers.ZeroAddress, [])
      const b = client.getContract("Foo", otherAddress, [])
      expect(b).not.toBe(a)
    })
  })

  describe("OPP events", () => {
    it("queries and filters the canonical OPPEnvelope event stream", async () => {
      const client = new EthereumClient(rpcUrl),
        // A REAL contract carrying the event, so `filters[OppEnvelopeEvent]()`
        // runs ethers' own topic machinery; only the network round-trip is
        // doubled.
        opp = client.getContract("Opp", ethers.ZeroAddress, OppEnvelopeAbi),
        envelopeEvent = Object.create(ethers.EventLog.prototype) as ethers.EventLog,
        // A plain `Log` — the non-EventLog the filter must drop.
        unparsed = Object.create(ethers.Log.prototype) as ethers.Log,
        queryFilter = jest.spyOn(opp, "queryFilter").mockResolvedValue([envelopeEvent, unparsed])

      await expect(client.getOPPEnvelopes(opp, 7)).resolves.toEqual([envelopeEvent])
      expect(queryFilter).toHaveBeenCalledWith(await opp.filters[EthereumClient.OppEnvelopeEvent](), 7)
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
