import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import { ProcessSignalName } from "@wireio/cluster-tool-shared"
import {
  ClioRunner,
  enrichClioError
} from "@wireio/cluster-tool/clients/wire/clio"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { toURL } from "@wireio/cluster-tool/utils"

import { TransactionRejection } from "../../fixtures/clio/transactionRejection.js"

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

    it("recognizes a JSON failed transaction trace without treating ambiguous output as rejection", () => {
      const stdout = JSON.stringify({
          transaction_id: "failed-transaction",
          processed: {
            id: "failed-transaction",
            receipt: null,
            except: {
              code: 3050003,
              message: "sysio_assert_message assertion failure"
            }
          }
        }),
        failure = { message: "Command failed: clio", stdout, stderr: "" },
        traceWithCode = (code: number | string) => ({
          ...failure,
          stdout: JSON.stringify({ processed: { except: { code } } })
        })
      expect(ClioRunner.isProvenUnapplied(failure)).toBe(true)
      expect(
        [
          { ...failure, killed: true },
          { ...failure, signal: "SIGTERM" },
          { ...failure, message: "Error 3200000: http exception" },
          traceWithCode(3040008),
          traceWithCode(3200000),
          traceWithCode(1),
          traceWithCode("3050003"),
          traceWithCode(3050003.5),
          traceWithCode(4000000),
          { ...failure, stdout: Buffer.from(stdout) },
          { ...failure, stdout: "null" },
          { ...failure, stdout: '{"processed":' },
          {
            ...failure,
            stdout: JSON.stringify({
              processed: { receipt: { status: "executed" } }
            })
          },
          {
            ...failure,
            stdout: JSON.stringify({
              processed: { action_traces: [{ except: { code: 3050003 } }] }
            })
          }
        ].map(ClioRunner.isProvenUnapplied)
      ).toEqual(Array(14).fill(false))
    })

    it("proves a push unapplied only by a failed connection or a chain rejection", () => {
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
        [
          "Failed http request to nodeop at http://127.0.0.1:1; is nodeop running?",
          "\u001b[31mError 3050003: sysio_assert_message assertion failure\u001b[0m",
          "Error 3040005: Expired Transaction"
        ].map(message => ClioRunner.isProvenUnapplied(failure(message)))
      ).toEqual([true, true, true])
      expect(
        [
          failure("Error 3200005: http request fail"),
          failure("Error 3040008: Duplicate transaction"),
          failure("Command failed: clio", {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          }),
          failure("Error 3050003: assertion failure", {
            killed: true,
            signal: "SIGTERM"
          })
        ].map(ClioRunner.isProvenUnapplied)
      ).toEqual([false, false, false, false])
      expect(ClioRunner.isProvenUnapplied("not an error")).toBe(false)
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

  describe("JSON transaction rejections", () => {
    /** Model execFile's separate stdout without inventing a text-mode chain error. */
    const failure = (response: object, fields: object = {}) =>
      Object.assign(new Error("Command failed: clio"), {
        stdout: JSON.stringify(response),
        ...fields
      })

    it.each([
      "Error 3050003: not a rejection",
      "Connection refused",
      "Failed http request to nodeop"
    ])("does not infer delivery from JSON console text: %s", console => {
      const response = {
          transaction_id: TransactionRejection.transaction_id,
          processed: {
            id: TransactionRejection.processed.id,
            receipt: { status: "executed" },
            action_traces: [{ console }]
          }
        },
        stdout = JSON.stringify(response),
        error = failure(response, {
          message: `Command failed: clio\n${stdout}`
        })
      expect(ClioRunner.isTransportFailure(error)).toBe(false)
      expect(ClioRunner.isProvenUnapplied(error)).toBe(false)
    })

    it("recognizes the failed transaction trace emitted by clio -j", () => {
      expect(ClioRunner.isProvenUnapplied(failure(TransactionRejection))).toBe(
        true
      )
    })

    it.each([
      Buffer.from(JSON.stringify(TransactionRejection)),
      Object(JSON.stringify(TransactionRejection)),
      {},
      1
    ])(
      "does not coerce non-string stdout into delivery evidence: %p",
      stdout => {
        const error = {
          message: "Error 3050003: Connection refused",
          stdout
        }
        expect(ClioRunner.isTransportFailure(error)).toBe(false)
        expect(ClioRunner.isProvenUnapplied(error)).toBe(false)
      }
    )

    it.each([3000000, 3999999])(
      "recognizes chain exception boundary %s",
      code => {
        expect(
          ClioRunner.isProvenUnapplied(
            failure({
              ...TransactionRejection,
              processed: {
                ...TransactionRejection.processed,
                scheduled: false,
                except: { ...TransactionRejection.processed.except, code }
              }
            })
          )
        ).toBe(true)
      }
    )

    it.each([
      ClioRunner.DuplicateTransactionCode,
      3200000,
      3200005,
      3200006,
      42,
      2999999,
      4000000,
      3050003.5,
      "3050003"
    ])("does not prove rejection from excluded or invalid code %s", code => {
      expect(
        ClioRunner.isProvenUnapplied(
          failure({
            ...TransactionRejection,
            processed: {
              ...TransactionRejection.processed,
              except: { ...TransactionRejection.processed.except, code }
            }
          })
        )
      ).toBe(false)
    })

    it.each(["executed", "soft_fail", "hard_fail"])(
      "does not treat a transaction with a %s receipt as unapplied",
      status => {
        expect(
          ClioRunner.isProvenUnapplied(
            failure({
              ...TransactionRejection,
              processed: {
                ...TransactionRejection.processed,
                receipt: { status }
              }
            })
          )
        ).toBe(false)
      }
    )

    it.each([
      { ...TransactionRejection, transaction_id: "different" },
      { ...TransactionRejection, transaction_id: "" },
      {
        ...TransactionRejection,
        processed: { ...TransactionRejection.processed, scheduled: true }
      },
      {
        ...TransactionRejection,
        processed: { except: TransactionRejection.processed.except }
      },
      { error: TransactionRejection.processed.except },
      { processed: { console: "Error 3050003: not a rejection envelope" } }
    ])(
      "fails closed on incomplete, unrelated, or scheduled responses",
      response => {
        expect(ClioRunner.isProvenUnapplied(failure(response))).toBe(false)
      }
    )

    it("does not override a killed subprocess or incomplete output", () => {
      expect(
        ClioRunner.isProvenUnapplied(
          failure(TransactionRejection, {
            killed: true,
            signal: ProcessSignalName.SIGTERM
          })
        )
      ).toBe(false)
      expect(
        ClioRunner.isProvenUnapplied(
          failure(TransactionRejection, {
            stdout: '{"transaction_id":'
          })
        )
      ).toBe(false)
      const stdout = '{"console":"Error 3050003: not a complete response"'
      expect(
        ClioRunner.isProvenUnapplied(
          failure(TransactionRejection, {
            stdout,
            message: `Command failed: clio\n${stdout}`
          })
        )
      ).toBe(false)
      expect(
        ClioRunner.isProvenUnapplied(
          failure(TransactionRejection, {
            message: "Error 3200000: http exception"
          })
        )
      ).toBe(false)
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
