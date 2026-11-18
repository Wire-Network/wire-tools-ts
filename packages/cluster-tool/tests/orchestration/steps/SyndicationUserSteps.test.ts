import { Keypair } from "@solana/web3.js"
import { SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import { Wallet } from "ethers"
import { SyndicationUserSteps } from "@wireio/cluster-tool/orchestration/steps"
import { Report } from "@wireio/cluster-tool/report"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { EthereumFundingTool } from "@wireio/cluster-tool/tools/ethereum"
import { AuthExLinkTool } from "@wireio/cluster-tool/tools/all"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { ethereumPublicKeyFromWallet } from "@wireio/cluster-tool/utils"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const signal = new AbortController().signal,
  account = "synd.parked",
  keypairName = "syndication-parked",
  /** The durable handle of the user's persisted Ethereum wallet. */
  walletName = "syndication-holder",
  tokenCode = "LIQSOL",
  net = 495_000_000n

afterEach(() => jest.restoreAllMocks())

describe("SyndicationUserSteps Ethereum link", () => {
  it("links the syndicating wallet, loaded by its handle, and propagates a refused link", async () => {
    const ctx = fixtureContext(),
      // A plain `Wallet` — the type `EthereumFundingTool.signer` hands back.
      wallet = new Wallet(Wallet.createRandom().privateKey),
      readWallet = jest
        .spyOn(EthereumFundingTool, "signer")
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
        walletName
      )
    expect(step.runner).toBe(SyndicationUserSteps.runLinkEthereumKey)
    expect(step.input).toEqual({
      kind: "SyndicationUserSteps.LinkEthereumKeyInput",
      account,
      walletName
    })
    await step.runner(ctx, step.input, signal)
    expect(readWallet).toHaveBeenCalledWith(ctx, walletName)
    // The link names the wallet's OWN public key and is signed by the wallet itself.
    expect(link.mock.calls[0][1]).toEqual({
      chainKind: ChainKind.EVM,
      account,
      publicKey: ethereumPublicKeyFromWallet(wallet).toString(),
      signer: wallet
    })
    link.mockRejectedValue(new Error("link refused"))
    await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
      "link refused"
    )
  })

  it("refuses cancellation before reading or linking the wallet", async () => {
    const readWallet = jest.spyOn(EthereumFundingTool, "signer"),
      link = jest.spyOn(AuthExLinkTool, "createLink"),
      step = SyndicationUserSteps.planLinkEthereumKey(
        Report.Actor.User,
        "link",
        "link",
        {},
        account,
        walletName
      )
    await expect(
      step.runner(fixtureContext(), step.input, AbortSignal.abort())
    ).rejects.toThrow()
    expect(readWallet).not.toHaveBeenCalled()
    expect(link).not.toHaveBeenCalled()
  })

  it("fails loudly for a handle whose wallet was never persisted", async () => {
    const link = jest.spyOn(AuthExLinkTool, "createLink"),
      step = SyndicationUserSteps.planLinkEthereumKey(
        Report.Actor.User,
        "link",
        "link",
        {},
        account,
        "never-created"
      )
    await expect(
      step.runner(fixtureContext(), step.input, signal)
    ).rejects.toThrow(/Ethereum wallet "never-created" not found/)
    expect(link).not.toHaveBeenCalled()
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
