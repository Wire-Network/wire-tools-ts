import { ethers } from "ethers"
import type { ExternalOutpostConfigEthereum } from "@wireio/cluster-tool-shared"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { EthereumOutpostTarget } from "@wireio/cluster-tool/tools/ethereum"
import { toURL } from "@wireio/cluster-tool/utils"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const OppAddress = "0x1111111111111111111111111111111111111111"
const PoolAddress = "0x2222222222222222222222222222222222222222"
const ChainId = 31_337
const EthereumPath = "/tmp/wire-ethereum-target-test"
/** The finalized block a document was generated at. */
const AsOfBlock = 1_234

/** An external config's Ethereum outpost, with or without an endpoint / as-of block. */
function externalEthereum(
  rpcUrl?: string,
  asOfBlock?: ExternalOutpostConfigEthereum["asOfBlock"]
): ExternalOutpostConfigEthereum {
  return {
    chainId: ChainId,
    ...(rpcUrl != null ? { rpcUrl } : {}),
    outpostAddresses: { OPP: OppAddress, OPPInbound: OppAddress, BAR: OppAddress },
    liqEthAddresses: { DepositManager: PoolAddress },
    ...(asOfBlock != null ? { asOfBlock } : {})
  }
}

describe("EthereumOutpostTarget", () => {
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    )
  })

  it("fromExternalOutpost composes the provider, artifact tree, chain id and both address books", () => {
    const provider = EthereumOutpostTarget.createProvider(rpcUrl),
      target = EthereumOutpostTarget.fromExternalOutpost(
        externalEthereum(rpcUrl),
        EthereumPath,
        provider
      )
    expect(target.provider).toBe(provider)
    expect(target.ethereumPath).toBe(EthereumPath)
    expect(target.chainId).toBe(ChainId)
    expect(target.outpostAddresses.OPP).toBe(OppAddress)
    expect(target.liqEthAddresses.DepositManager).toBe(PoolAddress)
    expect(provider).toBeInstanceOf(ethers.JsonRpcProvider)
    provider.destroy()
  })

  it("fromExternalOutpost carries the document's asOfBlock, and leaves it absent when the document has none", () => {
    expect(
      EthereumOutpostTarget.fromExternalOutpost(
        externalEthereum(rpcUrl, AsOfBlock),
        EthereumPath,
        null
      ).asOfBlock
    ).toBe(AsOfBlock)
    expect(
      "asOfBlock" in
        EthereumOutpostTarget.fromExternalOutpost(
          externalEthereum(rpcUrl),
          EthereumPath,
          null
        )
    ).toBe(false)
  })

  it("leaves liqEthAddresses absent when the outpost has no liqETH deploy", () => {
    const { liqEthAddresses, ...rest } = externalEthereum(rpcUrl),
      target = EthereumOutpostTarget.fromExternalOutpost(
        rest,
        EthereumPath,
        null
      )
    expect(liqEthAddresses).toBeDefined()
    expect("liqEthAddresses" in target).toBe(false)
  })

  it("is() tells a target from a build context", () => {
    expect(
      EthereumOutpostTarget.is(
        EthereumOutpostTarget.fromExternalOutpost(
          externalEthereum(rpcUrl),
          EthereumPath,
          null
        )
      )
    ).toBe(true)
    expect(EthereumOutpostTarget.is(fixtureContext())).toBe(false)
    expect(EthereumOutpostTarget.is(null)).toBe(false)
    expect(EthereumOutpostTarget.is({ provider: null })).toBe(false)
  })

  it("assertRpcUrl demands the endpoint a cluster-less command dials", () => {
    expect(EthereumOutpostTarget.assertRpcUrl(externalEthereum(rpcUrl))).toBe(
      rpcUrl
    )
    expect(() =>
      EthereumOutpostTarget.assertRpcUrl(externalEthereum())
    ).toThrow(/must carry ethereum\.rpcUrl/)
    expect(() =>
      EthereumOutpostTarget.assertRpcUrl(externalEthereum(""))
    ).toThrow(/must carry ethereum\.rpcUrl/)
  })

  it("assertChainId accepts the configured chain and refuses another", async () => {
    const providerFor = (chainId: bigint): ethers.Provider =>
      ({ getNetwork: async () => ({ chainId }) }) as unknown as ethers.Provider
    await expect(
      EthereumOutpostTarget.assertChainId(
        EthereumOutpostTarget.fromExternalOutpost(
          externalEthereum(rpcUrl),
          EthereumPath,
          providerFor(BigInt(ChainId))
        )
      )
    ).resolves.toBeUndefined()
    await expect(
      EthereumOutpostTarget.assertChainId(
        EthereumOutpostTarget.fromExternalOutpost(
          externalEthereum(rpcUrl),
          EthereumPath,
          providerFor(1n)
        )
      )
    ).rejects.toThrow(/fronts chain 1, not the configured 31337/)
  })
})
