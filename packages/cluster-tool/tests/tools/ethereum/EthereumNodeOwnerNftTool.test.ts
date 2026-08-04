import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { NodeOwnerTier, WireKey, WireKeyType } from "@wireio/opp-typescript-models"
import { commitNode, loadBar, type BarContract } from "@wireio/cluster-tool/tools/ethereum"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

/** A syntactically-valid deployed address for the fixture map. */
const BAR_ADDRESS = "0x00000000000000000000000000000000000000b1"

describe("EthereumNodeOwnerNftTool.loadBar", () => {
  let ethereumPath: string
  let signer: ethers.Signer

  beforeAll(() => {
    // A fake wire-ethereum root carrying only the hardhat BAR artifact.
    ethereumPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-repo-"))
    const artifactDir = Path.join(
      ethereumPath,
      "artifacts",
      "contracts",
      "outpost",
      "BAR.sol"
    )
    Fs.mkdirSync(artifactDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(artifactDir, "BAR.json"),
      JSON.stringify({ abi: [] })
    )
    signer = ethers.Wallet.createRandom()
  })

  afterAll(() => {
    Fs.rmSync(ethereumPath, { recursive: true, force: true })
  })

  it("binds the artifact ABI to the deployed address from outpost-addrs", () => {
    const contract = loadBar(ethereumPath, { BAR: BAR_ADDRESS }, signer)
    expect(contract.target).toBe(BAR_ADDRESS)
  })

  it("throws LOUDLY when BAR is absent from the address map", () => {
    expect(() => loadBar(ethereumPath, {}, signer)).toThrow(
      /BAR not in outpost-addrs\.json/
    )
  })

  it("throws when the hardhat artifact is missing", () => {
    const bareRepo = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-bare-"))
    try {
      expect(() => loadBar(bareRepo, { BAR: BAR_ADDRESS }, signer)).toThrow(
        /artifact not found/
      )
    } finally {
      Fs.rmSync(bareRepo, { recursive: true, force: true })
    }
  })
})

describe("EthereumNodeOwnerNftTool.commitNode", () => {
  const WIRE_ACCOUNT_NAME = "nftg"
  /** 65-byte SEC1 uncompressed depositor key (`0x04 || X || Y`). */
  const DEPOSITOR_PUBLIC_KEY = "0x04" + "11".repeat(64)
  const wireKey = WireKey.create({
    keyType: WireKeyType.K1,
    key: new Uint8Array(33).fill(2)
  })

  /** The on-chain tx count `getTransactionCount` is answered with. */
  const NonceSeed = 11

  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
    )
  })

  /** A stubbed `BarContract` plus the arg lists its `commitNode` recorded. */
  interface StubBar {
    contract: BarContract
    calls: unknown[][]
  }

  /**
   * `BarContract` recording forwarded args; `tx.wait()` resolves `receipt`.
   *
   * The runner is a REAL `ethers.Wallet` on a REAL provider, because
   * `commitNode` resolves its nonce through `resolveLatestNonce`, which reads
   * `contract.runner` as a Signer and its Provider. Only the chain round-trip
   * is spied — a fresh random wallet per call also keeps the module-level
   * nonce counter from leaking between tests.
   */
  function stubBar(receipt: unknown): StubBar {
    const calls: unknown[][] = [],
      provider = new ethers.JsonRpcProvider(rpcUrl),
      wallet = ethers.Wallet.createRandom().connect(provider)
    jest.spyOn(provider, "getTransactionCount").mockResolvedValue(NonceSeed)
    const contract = {
      commitNode: async (...args: unknown[]) => {
        calls.push(args)
        return { wait: async () => receipt }
      }
    } as BarContract
    // `runner` is readonly on `BaseContract`, so the real signer is installed
    // rather than declared inline — a literal carrying it no longer overlaps
    // `BarContract` at all, and widening the cast to hide that is exactly what
    // this sweep removed.
    Object.defineProperty(contract, "runner", {
      value: wallet,
      configurable: true
    })
    return { contract, calls }
  }

  it("forwards the claim args in order, pins the nonce, and returns the mined receipt", async () => {
    const receipt = { status: 1 }
    const { contract, calls } = stubBar(receipt)
    const result = await commitNode(
      contract,
      NodeOwnerTier.T1,
      WIRE_ACCOUNT_NAME,
      wireKey,
      DEPOSITOR_PUBLIC_KEY
    )
    expect(result).toBe(receipt)
    // The trailing overrides carry an EXPLICIT nonce: `commitNode` shares the
    // deployer signer with the rest of the harness, so letting ethers resolve
    // the nonce itself races concurrent submissions and fails NONCE_EXPIRED.
    expect(calls).toEqual([
      [
        NodeOwnerTier.T1,
        WIRE_ACCOUNT_NAME,
        wireKey,
        DEPOSITOR_PUBLIC_KEY,
        { nonce: NonceSeed }
      ]
    ])
  })

  it("throws LOUDLY when the transaction never mines (null receipt)", async () => {
    const { contract } = stubBar(null)
    await expect(
      commitNode(
        contract,
        NodeOwnerTier.T1,
        WIRE_ACCOUNT_NAME,
        wireKey,
        DEPOSITOR_PUBLIC_KEY
      )
    ).rejects.toThrow(/receipt is null/)
  })
})
