import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  ClioRunner,
  WireWallet
} from "@wireio/cluster-tool/clients/wire"
import { BindConfig } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

describe("WireWallet", () => {
  let dir: string
  let nodeopUrl: string
  beforeAll(async () => {
    nodeopUrl = toURL(await BindConfig.findAvailable(BindConfig.DefaultBiosHttp))
  })
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wirewallet-"))
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Path the fake clio records each `import` call to (baked into the script). */
  const importLogPath = () => Path.join(dir, "imports.log")

  /** A branching fake `clio` that records `import` calls to {@link importLogPath}. */
  const fakeClio = (unlockFails = false): string => {
    const p = Path.join(dir, "clio.sh")
    const unlockBody = unlockFails
      ? `echo 'Already unlocked: default' >&2; exit 1`
      : `echo unlocked`
    Fs.writeFileSync(
      p,
      [
        "#!/usr/bin/env bash",
        'sub=""',
        'for arg in "$@"; do case "$arg" in create|import|open|unlock) sub="$arg"; break;; esac; done',
        'case "$sub" in',
        `  create) echo 'Save password: "PW5FakePass"';;`,
        `  import) echo import >> "${importLogPath()}";;`,
        `  open) echo opened;;`,
        `  unlock) ${unlockBody};;`,
        "esac",
        "exit 0"
      ].join("\n") + "\n",
      { mode: 0o755 }
    )
    return p
  }
  const runner = (binary: string) =>
    new ClioRunner({
      clusterPath: dir,
      binary,
      nodeopUrl,
      kiodUrl: null
    })

  describe("getOrCreate", () => {
    it("captures + persists the PW console password", async () => {
      const wallet = await new WireWallet(runner(fakeClio())).getOrCreate()
      expect(wallet.password).toBe("PW5FakePass")
      expect(Fs.readFileSync(wallet.passwordFile, "utf8")).toBe("PW5FakePass")
    })
  })

  describe("constructor", () => {
    it("loads an existing password file as a value", () => {
      const walletPath = Path.join(dir, WireWallet.Subpath)
      Fs.mkdirSync(walletPath, { recursive: true })
      Fs.writeFileSync(
        Path.join(walletPath, WireWallet.PasswordFilename),
        "PWexisting\n"
      )
      expect(new WireWallet(runner(fakeClio())).password).toBe("PWexisting")
    })
    it("is null with no password file", () => {
      expect(new WireWallet(runner(fakeClio())).password).toBeNull()
    })
  })

  describe("addPrivateKey", () => {
    it("imports each non-empty key (flattening arrays) and is fluent", async () => {
      const wallet = new WireWallet(runner(fakeClio()))
      const returned = await wallet.addPrivateKey("k1", ["k2", "k3"], "")
      expect(returned).toBe(wallet)
      expect(
        Fs.readFileSync(importLogPath(), "utf8").trim().split("\n")
      ).toHaveLength(3)
    })
  })

  describe("unlock", () => {
    it("opens + unlocks and is fluent", async () => {
      const wallet = new WireWallet(runner(fakeClio()))
      expect(await wallet.unlock("pw")).toBe(wallet)
    })
    it("swallows a benign 'Already unlocked'", async () => {
      const wallet = new WireWallet(runner(fakeClio(true)))
      await expect(wallet.unlock("pw")).resolves.toBe(wallet)
    })
  })

  describe("namespace helpers", () => {
    it("errorMessage reads message ?? stderr", () => {
      expect(WireWallet.errorMessage(new Error("boom"))).toBe("boom")
      expect(WireWallet.errorMessage({ stderr: "from stderr" })).toBe("from stderr")
      expect(WireWallet.errorMessage(null)).toBe("")
    })
    it("tolerate returns the fallback on a benign match, else rethrows", () => {
      expect(WireWallet.tolerate(new Error("x already exists"), "already exists", "fb")).toBe("fb")
      expect(() => WireWallet.tolerate(new Error("fatal"), "already exists", "fb")).toThrow("fatal")
    })
    it("swallowBenign swallows a match (string or regex), else rethrows", () => {
      expect(() =>
        WireWallet.swallowBenign(new Error("Already unlocked"), "Already unlocked", "ok")
      ).not.toThrow()
      expect(() =>
        WireWallet.swallowBenign(new Error("cannot open it"), WireWallet.AlreadyOpenPattern, "ok")
      ).not.toThrow()
      expect(() =>
        WireWallet.swallowBenign(new Error("real failure"), "Already unlocked", "ok")
      ).toThrow("real failure")
    })
  })
})
