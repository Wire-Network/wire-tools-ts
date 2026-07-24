import { mkdtempSync } from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  createEthLoadWallets,
  EthLoadWalletFileVersion,
  EthTransferGas,
  readEthLoadWalletFile,
  saveEthLoadWalletFile,
  sweepableWei
} from "@wireio/opp-stress-harness"

describe("createEthLoadWallets", () => {
  it("generates the requested count of distinct EOAs", () => {
    const wallets = createEthLoadWallets(4)
    expect(wallets).toHaveLength(4)
    wallets.forEach((wallet, index) => {
      expect(wallet.index).toBe(index)
      expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(wallet.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/)
    })
    expect(new Set(wallets.map(w => w.address)).size).toBe(4)
  })

  it("rejects a non-positive count", () => {
    expect(() => createEthLoadWallets(0)).toThrow(/positive integer/)
  })
})

describe("sweepableWei", () => {
  const gasPrice = 1_000_000_000n,
    gasCost = EthTransferGas * gasPrice

  it("retains exactly one transfer's gas", () => {
    expect(sweepableWei(gasCost + 5n, gasPrice)).toBe(5n)
  })

  it("returns zero when the balance cannot cover gas", () => {
    expect(sweepableWei(gasCost, gasPrice)).toBe(0n)
    expect(sweepableWei(gasCost - 1n, gasPrice)).toBe(0n)
    expect(sweepableWei(0n, gasPrice)).toBe(0n)
  })
})

describe("eth wallet file", () => {
  it("round-trips a wallet set with its funder and recipient", () => {
    const path = Path.join(
        mkdtempSync(Path.join(Os.tmpdir(), "opp-eth-")),
        "eth-wallets.json"
      ),
      file = {
        version: EthLoadWalletFileVersion,
        funder: "0x0000000000000000000000000000000000000001",
        recipient: "loadrecipient",
        wallets: createEthLoadWallets(2)
      }
    saveEthLoadWalletFile(path, file)

    const loaded = readEthLoadWalletFile(path)
    expect(loaded.funder).toBe(file.funder)
    expect(loaded.recipient).toBe("loadrecipient")
    expect(loaded.wallets).toHaveLength(2)
    expect(loaded.wallets[0]?.privateKey).toBe(file.wallets[0]?.privateKey)
  })

  it("rejects an unsupported version", () => {
    const path = Path.join(
      mkdtempSync(Path.join(Os.tmpdir(), "opp-eth-")),
      "eth-wallets.json"
    )
    saveEthLoadWalletFile(path, {
      version: EthLoadWalletFileVersion + 1,
      funder: "0x01",
      recipient: "r",
      wallets: createEthLoadWallets(1)
    })
    expect(() => readEthLoadWalletFile(path)).toThrow(/unsupported eth wallet/)
  })
})
