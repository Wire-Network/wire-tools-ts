import { mkdtempSync } from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  buildRoundMajorRequests,
  createLoadWalletKeys,
  LoadWalletFileVersion,
  readLoadWalletFile,
  saveLoadWalletFile,
  type LoadWallet
} from "@wireio/opp-stress-harness"

/** Provisioned wallets, as `provision` would produce them. */
function wallets(count: number): readonly LoadWallet[] {
  return createLoadWalletKeys(count).map(key => ({
    ...key,
    account: `ldwallet${key.index}`
  }))
}

describe("buildRoundMajorRequests", () => {
  it("orders work round-major so a window spans distinct wallets", () => {
    // Given: three wallets performing two swaps each.
    const requests = buildRoundMajorRequests(wallets(3), 2)

    // Then: round 0 covers every wallet before round 1 begins.
    expect(requests).toHaveLength(6)
    expect(requests.slice(0, 3).map(r => r.round)).toEqual([0, 0, 0])
    expect(requests.slice(0, 3).map(r => r.wallet.index)).toEqual([0, 1, 2])
    expect(requests.slice(3).map(r => r.round)).toEqual([1, 1, 1])
  })

  it("rejects a non-positive swaps-per-wallet", () => {
    expect(() => buildRoundMajorRequests(wallets(1), 0)).toThrow(/positive integer/)
  })
})

describe("load wallet file", () => {
  it("round-trips a provisioned wallet set", () => {
    // Given: a provisioned set written to a temp path.
    const path = Path.join(
        mkdtempSync(Path.join(Os.tmpdir(), "opp-load-")),
        "wallets.json"
      ),
      file = {
        version: LoadWalletFileVersion,
        noncePrefix: "ld",
        funder: "wireno",
        wallets: wallets(2)
      }
    saveLoadWalletFile(path, file)

    // When/Then: reading it back preserves every wallet and its keys.
    const loaded = readLoadWalletFile(path)
    expect(loaded.funder).toBe("wireno")
    expect(loaded.noncePrefix).toBe("ld")
    expect(loaded.wallets).toHaveLength(2)
    expect(loaded.wallets[0]?.account).toBe("ldwallet0")
    expect(loaded.wallets[0]?.privateKey).toBe(file.wallets[0]?.privateKey)
    expect(loaded.wallets[0]?.destination.address).toBe(
      file.wallets[0]?.destination.address
    )
  })

  it("rejects an unsupported version", () => {
    const path = Path.join(
      mkdtempSync(Path.join(Os.tmpdir(), "opp-load-")),
      "wallets.json"
    )
    saveLoadWalletFile(path, {
      version: LoadWalletFileVersion + 1,
      noncePrefix: "ld",
      funder: "wireno",
      wallets: wallets(1)
    })
    expect(() => readLoadWalletFile(path)).toThrow(/unsupported wallet file version/)
  })

  it("rejects a wallet set with no wallets", () => {
    const path = Path.join(
      mkdtempSync(Path.join(Os.tmpdir(), "opp-load-")),
      "wallets.json"
    )
    saveLoadWalletFile(path, {
      version: LoadWalletFileVersion,
      noncePrefix: "ld",
      funder: "wireno",
      wallets: []
    })
    expect(() => readLoadWalletFile(path)).toThrow(/contains no wallets/)
  })
})
