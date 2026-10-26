import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  ClioRunner,
  enrichClioError
} from "@wireio/cluster-tool/clients/wire/clio"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

describe("ClioRunner", () => {
  let dir: string
  let nodeopUrl: string
  beforeAll(async () => {
    nodeopUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp)
    )
  })
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cliorunner-"))
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Write an executable bash script that ignores the prepended clio flags. */
  const makeScript = (name: string, body: string): string => {
    const p = Path.join(dir, name)
    Fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
    return p
  }
  const config = (binary: string) => ({
    clusterPath: dir,
    binary,
    nodeopUrl,
    kiodUrl: null
  })

  describe("run", () => {
    it("returns parsed JSON in json mode", async () => {
      const bin = makeScript("clio-json.sh", `echo '{"transaction_id":"abc"}'`)
      const result = await new ClioRunner(config(bin)).run(["push"], {
        json: true
      })
      expect(result).toEqual({ transaction_id: "abc" })
    })

    it("returns trimmed raw stdout otherwise", async () => {
      const bin = makeScript("clio-raw.sh", `echo 'plain output'`)
      const result = await new ClioRunner(config(bin)).run(["get", "info"])
      expect(result).toBe("plain output")
    })

    it("falls back to raw stdout when json is not parseable", async () => {
      const bin = makeScript("clio-bad.sh", `echo 'not json'`)
      const result = await new ClioRunner(config(bin)).run(["x"], {
        json: true
      })
      expect(result).toBe("not json")
    })

    it("enriches the thrown error with the child's stdout on failure", async () => {
      const bin = makeScript(
        "clio-fail.sh",
        `echo 'assertion failure with message: boom'; exit 1`
      )
      await expect(new ClioRunner(config(bin)).run(["push"])).rejects.toThrow(
        /assertion failure with message: boom/
      )
    })
  })

  describe("transport retries", () => {
    /** A clio that records each run in `runs` and fails with `stderr` until its `passOn`th run. */
    const flakyClio = (stderr: string, passOn: number) => {
      const runs = Path.join(dir, "runs")
      return {
        runs,
        bin: makeScript(
          "clio-flaky.sh",
          [
            `echo run >> '${runs}'`,
            `if [ "$(wc -l < '${runs}')" -lt ${passOn} ]; then echo '${stderr}' >&2; exit 1; fi`,
            `echo '{"transaction_id":"abc"}'`
          ].join("\n")
        )
      }
    }
    const runCount = (runs: string) =>
      Fs.readFileSync(runs, "utf-8").trim().split("\n").length

    it("re-runs a command whose connection failed", async () => {
      const { bin, runs } = flakyClio(
        "Failed http request to nodeop at http://127.0.0.1:1; is nodeop running?",
        2
      )
      await expect(
        new ClioRunner(config(bin)).run(["push"], { json: true })
      ).resolves.toEqual({ transaction_id: "abc" })
      expect(runCount(runs)).toBe(2)
    })

    it("never re-runs a command whose request may have reached the node", async () => {
      const { bin, runs } = flakyClio("Error 3200000: http exception", 2)
      await expect(
        new ClioRunner(config(bin)).run(["push"], { json: true })
      ).rejects.toThrow(/Error 3200000/)
      expect(runCount(runs)).toBe(1)
    })

    it("tells a failed connection from a push that may have been sent", () => {
      const failure = (message: string, fields: object = {}) => ({
        message,
        ...fields
      })
      expect(
        ClioRunner.isTransportFailure(
          failure("couldn't connect to server: Connection refused")
        )
      ).toBe(true)
      expect(
        ClioRunner.isTransportFailure(failure("Error 3200000: http exception"))
      ).toBe(false)
      expect(
        ClioRunner.isAmbiguousSubmission(
          failure("Error 3200005: http request fail")
        )
      ).toBe(true)
      expect(
        ClioRunner.isAmbiguousSubmission(
          failure("Command failed", { killed: true, signal: "SIGTERM" })
        )
      ).toBe(true)
      expect(
        ClioRunner.isAmbiguousSubmission(
          failure("Error 3050003: assertion failure")
        )
      ).toBe(false)
      expect(ClioRunner.isAmbiguousSubmission("not an error")).toBe(false)
    })
  })

  describe("enrichClioError", () => {
    it("folds stdout + stderr into the error message", () => {
      const err = new Error("Command failed")
      enrichClioError(err, "chain says no", "stderr noise")
      expect(err.message).toContain("Command failed")
      expect(err.message).toContain("chain says no")
      expect(err.message).toContain("stderr noise")
    })

    it("returns non-message values untouched", () => {
      expect(enrichClioError("just a string", "a", "b")).toBe("just a string")
      expect(enrichClioError(null, "a", "b")).toBeNull()
    })
  })

  describe("ErrorFragment", () => {
    it("carries the recognised fragments", () => {
      expect(ClioRunner.ErrorFragment.AccountAlreadyExists).toBe(
        "already exists"
      )
      expect(ClioRunner.ErrorFragment.WalletAlreadyUnlocked).toBe(
        "Already unlocked"
      )
    })
  })
})
