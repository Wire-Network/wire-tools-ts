import { Keypair } from "@solana/web3.js"
import { KeyType, SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import { Wallet } from "ethers"
import { Constants } from "@wireio/cluster-tool/Constants"
import { SyndicationUserSteps } from "@wireio/cluster-tool/orchestration/steps"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { EthereumSyndicationTool } from "@wireio/cluster-tool/tools/ethereum"
import { AuthExLinkTool } from "@wireio/cluster-tool/tools/all"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const signal = new AbortController().signal,
  account = "synd.parked",
  keypairName = "syndication-parked",
  tokenCode = "LIQSOL",
  net = 495_000_000n

afterEach(() => jest.restoreAllMocks())

describe("SyndicationUserSteps Ethereum link", () => {
  it("links the syndicating wallet and propagates a refused link", async () => {
    const ctx = fixtureContext(),
      wallet = Wallet.createRandom(),
      readWallet = jest
        .spyOn(EthereumSyndicationTool, "hdWallet")
        .mockReturnValue(wallet),
      link = jest
        .spyOn(AuthExLinkTool, "createLink")
        .mockResolvedValue(undefined),
      step = SyndicationUserSteps.planLinkEthereumKey(
        Report.Actor.User,
        "link",
        "link",
        {},
        account,
        48
      )
    expect(step.runner).toBe(SyndicationUserSteps.runLinkEthereumKey)
    expect(step.input).toEqual({
      kind: "SyndicationUserSteps.LinkEthereumKeyInput",
      account,
      ethereumHdIndex: 48
    })
    await step.runner(ctx, step.input, signal)
    expect(readWallet).toHaveBeenCalledWith(ctx, 48)
    expect(link.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        chainKind: ChainKind.EVM,
        account,
        ethereumWallet: wallet
      })
    )
    expect(link.mock.calls[0][1].privateKey.type).toBe(KeyType.EM)
    link.mockRejectedValue(new Error("link refused"))
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
      "link refused"
    )
  })

  it("refuses cancellation before reading or linking the wallet", async () => {
    const readWallet = jest.spyOn(EthereumSyndicationTool, "hdWallet"),
      link = jest.spyOn(AuthExLinkTool, "createLink"),
      step = SyndicationUserSteps.planLinkEthereumKey(
        Report.Actor.User,
        "link",
        "link",
        {},
        account,
        48
      )
    await expect(
      step.runner(fixtureContext(), step.input, AbortSignal.abort())
    ).rejects.toThrow()
    expect(readWallet).not.toHaveBeenCalled()
    expect(link).not.toHaveBeenCalled()
  })
})

describe("SyndicationUserSteps.nodeOwnerPolicy", () => {
  it("builds the node owner's addpolicy with the given weights", () => {
    expect(
      SyndicationUserSteps.nodeOwnerPolicy("op", {
        net: "0.0000 SYS",
        cpu: "1.0000 SYS",
        ram: "2.0000 SYS"
      })
    ).toEqual({
      owner: "op",
      issuer: Constants.BOOTSTRAP_NODE_OWNER,
      net_weight: "0.0000 SYS",
      cpu_weight: "1.0000 SYS",
      ram_weight: "2.0000 SYS",
      time_block: 0,
      network_gen: 0
    })
  })
})

describe("SyndicationUserSteps parked-credit checks", () => {
  /** Serve the recipient's parked row and liquid balance; returns the parked-read spy. */
  function serve(parked: bigint | undefined, liquid: bigint) {
    const keypair = Keypair.generate()
    jest.spyOn(SolanaFundingTool, "loadKeypair").mockReturnValue(keypair)
    jest.spyOn(WireSyndicationTool, "readLiqBalance").mockResolvedValue(liquid)
    const read = jest
      .spyOn(WireSyndicationTool, "readParked")
      .mockResolvedValue(
        parked == null
          ? undefined
          : ({
              balance: parked.toString()
            } as SysioContracts.SysioSyndParkedRowType)
      )
    return { keypair, read }
  }

  it("plans typed Steps carrying the recipient, token and net", () => {
    const step = SyndicationUserSteps.planVerifyParkedCredit(
      Report.Actor.User,
      "parked",
      "parked",
      {},
      account,
      keypairName,
      tokenCode,
      net
    )
    expect(step.input).toEqual({
      kind: "SyndicationUserSteps.ParkedCreditInput",
      account,
      keypairName,
      tokenCode,
      expectedNet: net
    })
    expect(step.runner).toBe(SyndicationUserSteps.runVerifyParkedCredit)
    expect(
      SyndicationUserSteps.planVerifyParkedDelivered(
        Report.Actor.User,
        "delivered",
        "delivered",
        {},
        account,
        keypairName,
        tokenCode,
        net
      ).runner
    ).toBe(SyndicationUserSteps.runVerifyParkedDelivered)
  })

  const input: SyndicationUserSteps.ParkedCreditInput = {
    kind: "SyndicationUserSteps.ParkedCreditInput",
    account,
    keypairName,
    tokenCode,
    expectedNet: net
  }

  it.each([
    ["exact net, empty account", net, 0n, true],
    ["short parked row", net - 1n, 0n, false],
    ["account already credited", net, 1n, false],
    ["nothing parked", undefined, 0n, false]
  ])("parked credit: %s", async (_label, parked, liquid, passes) => {
    const ctx = fixtureContext(),
      { keypair, read } = serve(parked, liquid),
      result = SyndicationUserSteps.runVerifyParkedCredit(ctx, input, signal)
    if (passes) await result
    else await expect(result).rejects.toThrow()
    expect(read).toHaveBeenCalledWith(
      ctx,
      tokenCode,
      SysioContracts.SysioSyndChainkind.CHAIN_KIND_SVM,
      keypair.publicKey.toBuffer().toString("hex")
    )
  })

  it.each([
    ["delivered, row gone", undefined, net, true],
    ["delivered, row emptied", 0n, net, true],
    ["row still holds credit", 1n, net, false],
    ["account short", undefined, net - 1n, false]
  ])("parked delivered: %s", async (_label, parked, liquid, passes) => {
    const ctx = fixtureContext()
    serve(parked, liquid)
    const result = SyndicationUserSteps.runVerifyParkedDelivered(
      ctx,
      input,
      signal
    )
    if (passes) await result
    else await expect(result).rejects.toThrow()
  })

  it("refuses an aborted check before reading", async () => {
    const { read } = serve(net, 0n)
    await expect(
      SyndicationUserSteps.runVerifyParkedCredit(
        fixtureContext(),
        input,
        AbortSignal.abort()
      )
    ).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})
