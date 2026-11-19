import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { EthereumWallet } from "@wireio/cluster-tool/clients/ethereum"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import { Report, StepExtraRecorder } from "@wireio/cluster-tool/report"
import { EthereumFundingTool } from "@wireio/cluster-tool/tools/ethereum"
import type { EthereumKeyPair } from "@wireio/cluster-tool/types"
import { ethereumKeyPairFromWallet } from "@wireio/cluster-tool/utils"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const signal = new AbortController().signal
/** A flow-owned handle. */
const WalletName = "holder"
/** What the wallet is for — lands in the keygen record. */
const Purpose = "a flow's liqETH holder"
/** A handle no test persists. */
const AbsentWalletName = "absent"
/** A balance to set, in wei. */
const BalanceWei = 5n * ethers.WeiPerEther
/** A build dir holding NO binary — EM generation needs none. */
const BinaryLessBuildPath = "/nonexistent/build"

/** A random EM pair, persisted under `name` in `dataPath`. */
function persistWallet(dataPath: string, name: string): EthereumKeyPair {
  return EthereumWallet.saveWallet(
    dataPath,
    name,
    ethereumKeyPairFromWallet(ethers.Wallet.createRandom())
  )
}

describe("EthereumFundingTool", () => {
  let dataPath: string

  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-funding-"))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  /** A REAL context whose data dir is this test's sandbox. */
  const context = () => fixtureContext({ dataPath })

  it("funds the deployer far past the panic account — both positive", () => {
    expect(EthereumFundingTool.DeployerBalanceWei).toBe(
      100_000n * ethers.WeiPerEther
    )
    expect(EthereumFundingTool.PanicBalanceWei).toBe(10n * ethers.WeiPerEther)
    expect(EthereumFundingTool.DeployerBalanceWei).toBeGreaterThan(
      EthereumFundingTool.PanicBalanceWei
    )
    expect(EthereumFundingTool.PanicBalanceWei).toBeGreaterThan(0n)
  })

  describe("planCreateWallet / runCreateWallet", () => {
    it("plans a typed step carrying the handle and purpose, with its named runner", () => {
      const step = EthereumFundingTool.planCreateWallet(
        Report.Actor.User,
        "create-holder",
        "generate the holder wallet",
        {},
        WalletName,
        Purpose
      )
      expect(step.actor).toBe(Report.Actor.User)
      expect(step.input).toEqual({
        kind: "EthereumFundingTool.CreateWalletInput",
        walletName: WalletName,
        purpose: Purpose
      })
      expect(step.runner).toBe(EthereumFundingTool.runCreateWallet)
    })

    it("generates a RANDOM wallet through the facade, persists it under the handle, and records its identity only", async () => {
      const ctx = context(),
        recorder = new StepExtraRecorder(),
        step = EthereumFundingTool.planCreateWallet(
          Report.Actor.User,
          "create-holder",
          "generate the holder wallet",
          {},
          WalletName,
          Purpose
        )
      expect(EthereumWallet.hasWallet(dataPath, WalletName)).toBe(false)
      await StepExtraRecorder.runWith(recorder, () =>
        step.runner(ctx, step.input, signal)
      )
      const pair = EthereumWallet.loadKeyPair(dataPath, WalletName)
      expect(pair.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(recorder.calls).toContainEqual(
        expect.objectContaining({
          client: "ethers",
          kind: "keygen",
          purpose: Purpose,
          publicKey: pair.publicKey,
          address: pair.address
        })
      )
      expect(JSON.stringify(recorder.calls)).not.toContain(pair.privateKey)
    })

    it("is idempotent — a re-run keeps the existing wallet and notes it instead of minting another", async () => {
      const ctx = context(),
        step = EthereumFundingTool.planCreateWallet(
          Report.Actor.User,
          "create-holder",
          "generate the holder wallet",
          {},
          WalletName,
          Purpose
        )
      await step.runner(ctx, step.input, signal)
      const first = EthereumWallet.loadKeyPair(dataPath, WalletName),
        recorder = new StepExtraRecorder()
      await StepExtraRecorder.runWith(recorder, () =>
        step.runner(ctx, step.input, signal)
      )
      expect(EthereumWallet.loadKeyPair(dataPath, WalletName)).toEqual(first)
      expect(recorder.calls).toEqual([
        expect.objectContaining({
          client: "harness",
          kind: "note",
          text: expect.stringMatching(/already exists — kept/),
          walletName: WalletName,
          address: first.address
        })
      ])
    })

    it("refuses an aborted signal before creating anything", async () => {
      const step = EthereumFundingTool.planCreateWallet(
        Report.Actor.User,
        "create-holder",
        "generate the holder wallet",
        {},
        WalletName,
        Purpose
      )
      await expect(
        step.runner(context(), step.input, AbortSignal.abort())
      ).rejects.toThrow()
      expect(EthereumWallet.hasWallet(dataPath, WalletName)).toBe(false)
    })
  })

  describe("createWallet (get-or-create)", () => {
    const keyContext = KeyGenerator.context(BinaryLessBuildPath)

    it("mints a RANDOM wallet once and reads the SAME persisted pair back on every later call", async () => {
      const first = await EthereumFundingTool.createWallet(
        dataPath,
        WalletName,
        keyContext,
        Purpose
      )
      expect(EthereumWallet.hasWallet(dataPath, WalletName)).toBe(true)
      expect(first).toEqual(EthereumWallet.loadKeyPair(dataPath, WalletName))
      await expect(
        EthereumFundingTool.createWallet(dataPath, WalletName, keyContext, Purpose)
      ).resolves.toEqual(first)
    })

    it("gives different handles different wallets", async () => {
      const holder = await EthereumFundingTool.createWallet(
          dataPath,
          WalletName,
          keyContext,
          Purpose
        ),
        other = await EthereumFundingTool.createWallet(
          dataPath,
          "other-holder",
          keyContext,
          Purpose
        )
      expect(other.address).not.toBe(holder.address)
      expect(other.privateKey).not.toBe(holder.privateKey)
    })

    it("records ONE keygen for the mint and none for the read-back — an identity is never regenerated", async () => {
      const minted = new StepExtraRecorder(),
        reread = new StepExtraRecorder()
      await StepExtraRecorder.runWith(minted, () =>
        EthereumFundingTool.createWallet(dataPath, WalletName, keyContext, Purpose)
      )
      await StepExtraRecorder.runWith(reread, () =>
        EthereumFundingTool.createWallet(dataPath, WalletName, keyContext, Purpose)
      )
      expect(
        minted.calls.filter(call => call.kind === "keygen")
      ).toHaveLength(1)
      expect(reread.calls).toEqual([])
    })
  })

  describe("planSetBalance / runSetBalance", () => {
    it("plans a typed step carrying the handle and the balance, with its named runner", () => {
      const step = EthereumFundingTool.planSetBalance(
        Report.Actor.User,
        "fund-holder",
        "fund the holder",
        {},
        WalletName,
        BalanceWei
      )
      expect(step.actor).toBe(Report.Actor.User)
      expect(step.input).toEqual({
        kind: "EthereumFundingTool.SetBalanceInput",
        walletName: WalletName,
        balanceWei: BalanceWei
      })
      expect(step.runner).toBe(EthereumFundingTool.runSetBalance)
    })

    it("sets the PERSISTED wallet's balance through exactly one anvil_setBalance", async () => {
      const ctx = context(),
        pair = persistWallet(dataPath, WalletName),
        setBalance = jest
          .spyOn(ctx.ethereum, "setBalance")
          .mockResolvedValue(undefined),
        step = EthereumFundingTool.planSetBalance(
          Report.Actor.User,
          "fund-holder",
          "fund the holder",
          {},
          WalletName,
          BalanceWei
        )
      await step.runner(ctx, step.input, signal)
      expect(setBalance).toHaveBeenCalledTimes(1)
      expect(setBalance).toHaveBeenCalledWith(pair.address, BalanceWei)
    })

    it("refuses a non-positive balance before touching the chain", async () => {
      const ctx = context(),
        setBalance = jest.spyOn(ctx.ethereum, "setBalance")
      persistWallet(dataPath, WalletName)
      await expect(
        EthereumFundingTool.runSetBalance(
          ctx,
          {
            kind: "EthereumFundingTool.SetBalanceInput",
            walletName: WalletName,
            balanceWei: 0n
          },
          signal
        )
      ).rejects.toThrow(/balanceWei must be positive/)
      expect(setBalance).not.toHaveBeenCalled()
    })

    it("refuses a handle whose wallet was never persisted — there is no address to fund", async () => {
      const ctx = context(),
        setBalance = jest.spyOn(ctx.ethereum, "setBalance"),
        step = EthereumFundingTool.planSetBalance(
          Report.Actor.User,
          "fund-absent",
          "fund an absent wallet",
          {},
          AbsentWalletName,
          BalanceWei
        )
      await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
        /Ethereum wallet "absent" not found/
      )
      expect(setBalance).not.toHaveBeenCalled()
    })

    it("refuses an aborted signal and propagates the faucet's failure", async () => {
      const ctx = context(),
        setBalance = jest
          .spyOn(ctx.ethereum, "setBalance")
          .mockRejectedValue(new Error("anvil refused")),
        step = EthereumFundingTool.planSetBalance(
          Report.Actor.User,
          "fund-holder",
          "fund the holder",
          {},
          WalletName,
          BalanceWei
        )
      persistWallet(dataPath, WalletName)
      await expect(
        step.runner(ctx, step.input, AbortSignal.abort())
      ).rejects.toThrow()
      expect(setBalance).not.toHaveBeenCalled()
      await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
        "anvil refused"
      )
    })
  })

  describe("signer / compressedPubkey", () => {
    it("signer is the persisted wallet, connected to the run's provider", () => {
      const ctx = context(),
        pair = persistWallet(dataPath, WalletName),
        signer = EthereumFundingTool.signer(ctx, WalletName)
      expect(signer.address).toBe(pair.address)
      expect(signer.provider).toBe(ctx.ethereum.provider)
    })

    it("compressedPubkey is the 33-byte key that recovers to the persisted wallet's address", () => {
      const pair = persistWallet(dataPath, WalletName),
        key = EthereumFundingTool.compressedPubkey(context(), WalletName)
      expect(ethers.getBytes(key)).toHaveLength(33)
      expect(ethers.computeAddress(key)).toBe(pair.address)
    })

    it("both fail loudly for a handle that was never persisted", () => {
      const ctx = context()
      expect(() => EthereumFundingTool.signer(ctx, AbsentWalletName)).toThrow(
        /Ethereum wallet "absent" not found/
      )
      expect(() =>
        EthereumFundingTool.compressedPubkey(ctx, AbsentWalletName)
      ).toThrow(/Ethereum wallet "absent" not found/)
    })
  })
})
