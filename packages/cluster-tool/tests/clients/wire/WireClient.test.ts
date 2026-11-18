import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import { identity } from "lodash"
import {
  Action,
  API,
  APIClient,
  APIError,
  Authority,
  createClassicSigner,
  KeyType,
  Name,
  PrivateKey,
  PublicKey,
  SysioContracts
} from "@wireio/sdk-core"
import { NestedError } from "@wireio/shared"
import { Constants, ProtocolTiming } from "@wireio/cluster-tool/Constants"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import {
  ClioRunner,
  WireClient,
  type WireClientConfig
} from "@wireio/cluster-tool/clients/wire"
import { toURL } from "@wireio/cluster-tool/utils"
import { enrichClioError } from "@wireio/cluster-tool/clients/wire/clio"

import { TransactionRejection } from "../../fixtures/clio/transactionRejection.js"
import { NewAccountTraceFixture } from "../../fixtures/NewAccountTraceFixture.js"

describe("WireClient", () => {
  let config: WireClientConfig
  beforeAll(async () => {
    config = {
      clusterPath: Os.tmpdir(),
      binary: Path.join(Os.tmpdir(), "clio"),
      nodeopUrl: toURL(
        await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultBiosHttp
        )
      ),
      kiodUrl: null
    }
  })

  describe("getWireBalance", () => {
    afterEach(() => jest.restoreAllMocks())

    it.each([
      ["0.000000000 WIRE", 0n],
      ["0.000000001 WIRE", 1n],
      ["12.345678901 WIRE", 12_345_678_901n],
      ["9007199.254740993 WIRE", 9_007_199_254_740_993n],
      ["-0.000000001 WIRE", -1n],
      ["-12.345678901 WIRE", -12_345_678_901n]
    ])(
      "reads %s as exact nine-decimal base units",
      async (quantity, expected) => {
        const client = new WireClient(config),
          balance = jest.spyOn(client.api.v1.chain, "get_currency_balance")
        jest.spyOn(client.api.v1Provider, "call").mockResolvedValue({
          status: 200,
          headers: {},
          json: [quantity],
          text: JSON.stringify([quantity])
        })

        await expect(client.getWireBalance("alice")).resolves.toBe(expected)
        expect(balance).toHaveBeenCalledWith("sysio.token", "alice", "WIRE")
      }
    )

    it("returns zero when no balance row exists", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client.api.v1.chain, "get_currency_balance")
        .mockResolvedValue([])

      await expect(client.getWireBalance("alice")).resolves.toBe(0n)
    })

    it("propagates currency balance RPC failures", async () => {
      const client = new WireClient(config),
        error = new Error("currency balance RPC failed")
      jest
        .spyOn(client.api.v1.chain, "get_currency_balance")
        .mockRejectedValue(error)

      await expect(client.getWireBalance("alice")).rejects.toBe(error)
    })
  })

  // The regression suite for the 2026-08-04 double-push: a finality wait that
  // does not resolve must NEVER re-send. `newaccount` failed loudly then; a
  // re-pushed transfer/deposit would have succeeded twice, silently.
  describe("withFinality re-push safety (via createAccount)", () => {
    const TransactionId = "a400888817429491c0ba8bfbb9d36f8439ad8577dc4e335a61b"

    /** A client whose push succeeds and whose inclusion wait never resolves. */
    function clientWithUnresolvedWait() {
      const client = new WireClient(config),
        send = jest
          .spyOn(client["runner"], "run")
          .mockResolvedValue({ transaction_id: TransactionId } as never)
      jest
        .spyOn(client, "waitForTransactionInBlock")
        .mockRejectedValue(new Error("not found in blocks 1–6 within 60000ms"))
      return { client, send }
    }

    /** `get_info` with a head time `offsetSec` from now (drives expiry). */
    function infoAt(offsetSec: number) {
      return {
        last_irreversible_block_num: 10,
        head_block_time: new Date(Date.now() + offsetSec * 1000)
          .toISOString()
          .replace("Z", "")
      } as never
    }

    afterEach(() => jest.restoreAllMocks())

    it("does NOT re-push when the transaction is still applied", async () => {
      const { client, send } = clientWithUnresolvedWait()
      // The re-read LOCATES it — exactly run-5's case (the account existed).
      jest
        .spyOn(client, "getTransaction")
        .mockResolvedValue({ block_num: 268 } as never)
      jest.spyOn(client, "getInfo").mockResolvedValue(infoAt(0))

      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/NOT re-pushed/)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it("does NOT re-push when the re-read itself FAILED", async () => {
      const { client, send } = clientWithUnresolvedWait()
      // A trace-api 500 / socket reset is "could not ask", NOT "it is gone".
      // Laundering this into a fork-out is what re-pushed an applied tx.
      jest
        .spyOn(client, "getTransaction")
        .mockRejectedValue(new Error("HTTP 500"))
      jest.spyOn(client, "getInfo").mockResolvedValue(infoAt(0))

      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/NOT re-pushed/)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it("does NOT re-push while the transaction could still be included", async () => {
      const { client, send } = clientWithUnresolvedWait()
      // Absent, but the TAPOS window is still OPEN — absence alone is not proof.
      jest.spyOn(client, "getTransaction").mockResolvedValue(null as never)
      jest.spyOn(client, "getInfo").mockResolvedValue(infoAt(0))

      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/NOT re-pushed/)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it("DOES re-push once the expiration window has closed while absent", async () => {
      const { client, send } = clientWithUnresolvedWait()
      // Absent AND head time is past pushedAt + TransactionExpirationSec, so
      // it can never be included — the one state where re-push is provably safe.
      jest.spyOn(client, "getTransaction").mockResolvedValue(null as never)
      jest
        .spyOn(client, "getInfo")
        .mockResolvedValue(infoAt(WireClient.TransactionExpirationSec + 60))

      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/can never apply/)
      expect(send.mock.calls.length).toBeGreaterThan(1)
      expect(send).toHaveBeenCalledTimes(WireClient.FinalityMaxAttempts)
    })

    /** A clio failure shaped like `execFile`'s rejection of a run that printed `stderr`. */
    function clioFailure(stderr: string, fields: object = {}) {
      return Object.assign(new Error(`Command failed: clio\n${stderr}`), {
        stderr,
        ...fields
      })
    }

    it("does NOT re-send a push whose reply was lost (http_exception)", async () => {
      const client = new WireClient(config),
        send = jest
          .spyOn(client["runner"], "run")
          .mockRejectedValue(
            clioFailure(
              "Error 3200000: http exception\nError Details:\nFailure when receiving data from the peer"
            ) as never
          )
      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/may have reached the node, so it is not re-sent/)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it("does NOT re-send a push whose clio was killed by its timeout", async () => {
      const client = new WireClient(config),
        send = jest
          .spyOn(client["runner"], "run")
          .mockRejectedValue(
            clioFailure("", { killed: true, signal: "SIGTERM" }) as never
          )
      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/not re-sent/)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it.each([
      ["the node already has", "Error 3040008: Duplicate transaction", {}],
      [
        "failed unrecognizably",
        "",
        { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }
      ]
    ])("does NOT re-send a push that %s", async (_case, stderr, fields) => {
      const client = new WireClient(config),
        send = jest
          .spyOn(client["runner"], "run")
          .mockRejectedValue(clioFailure(stderr, fields) as never)
      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/not re-sent/)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it("re-sends a push the node rejected", async () => {
      const client = new WireClient(config),
        send = jest
          .spyOn(client["runner"], "run")
          .mockRejectedValue(
            clioFailure(
              "Error 3050003: sysio_assert_message assertion failure"
            ) as never
          )
      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/assertion failure/)
      expect(send).toHaveBeenCalledTimes(WireClient.PushMaxAttempts)
    })

    it("preserves a JSON contract rejection instead of masking it as an ambiguous push", async () => {
      const client = new WireClient(config),
        stdout = JSON.stringify(TransactionRejection),
        send = jest
          .spyOn(client["runner"], "run")
          .mockRejectedValue(clioFailure(stdout, { stdout }) as never)
      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).rejects.toThrow(/Tier level must be between 1 and 3/)
      expect(send).toHaveBeenCalledTimes(WireClient.PushMaxAttempts)
    })

    it.each([ClioRunner.DuplicateTransactionCode, 3200000])(
      "never re-sends an ambiguous JSON error %s",
      async code => {
        const client = new WireClient(config),
          stdout = JSON.stringify({
            ...TransactionRejection,
            processed: {
              ...TransactionRejection.processed,
              except: { ...TransactionRejection.processed.except, code }
            }
          }),
          send = jest
            .spyOn(client["runner"], "run")
            .mockRejectedValue(clioFailure(stdout, { stdout }) as never)
        await expect(
          client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
        ).rejects.toThrow(/not re-sent/)
        expect(send).toHaveBeenCalledTimes(1)
      }
    )

    it("surfaces a zero-exit JSON kicker rejection without entering finality", async () => {
      const clusterPath = Fs.mkdtempSync(
          Path.join(Os.tmpdir(), "wire-kicker-rejection-")
        ),
        binary = Path.join(clusterPath, "clio"),
        runsFile = Path.join(clusterPath, "runs"),
        refusal = "TWAP window must be at least 60 seconds",
        response = {
          ...TransactionRejection,
          processed: {
            ...TransactionRejection.processed,
            except: {
              ...TransactionRejection.processed.except,
              stack: [{ msg: `assertion failure with message: ${refusal}` }]
            }
          }
        },
        client = new WireClient({ ...config, clusterPath, binary }),
        wait = jest
          .spyOn(client, "waitForTransactionInBlock")
          .mockRejectedValue(new Error("not included")),
        lookup = jest
          .spyOn(client, "getTransaction")
          .mockResolvedValue(null as never)
      jest.spyOn(client, "getInfo").mockResolvedValue(infoAt(0))
      Fs.writeFileSync(
        binary,
        [
          "#!/usr/bin/env bash",
          `printf 'run\\n' >> '${runsFile}'`,
          `printf '%s\\n' '${JSON.stringify(response)}'`
        ].join("\n"),
        { mode: 0o755 }
      )
      try {
        const action: SysioContracts.SysioKickerSetconfigAction = {
          cfg: {
            budget_remaining: "1000",
            min_interval_sec: 60,
            twap_window_sec: 59,
            max_spot_deviation_bps: 5000
          }
        }
        await expect(
          client.invokeTransaction(
            client
              .getSysioContract(SysioContracts.SysioContractName.kicker)
              .actions.setconfig.prepare(action, {
                authorization: WireClient.activeAuthorization("sysio")
              })
          )
        ).rejects.toThrow(refusal)
        expect(
          Fs.readFileSync(runsFile, "utf8").trim().split("\n")
        ).toHaveLength(WireClient.PushMaxAttempts)
        expect(wait).not.toHaveBeenCalled()
        expect(lookup).not.toHaveBeenCalled()
      } finally {
        Fs.rmSync(clusterPath, { recursive: true, force: true })
      }
    })

    it("preserves a JSON assertion refusal from a typed desyndicate with max_fee", async () => {
      const client = new WireClient(config),
        refusal = "the andon cord is pulled: funds cannot leave custody",
        amount = 500_000_000n,
        feeBps = 5n,
        flatFee = 100_000n,
        data: SysioContracts.SysioSyndDesyndicateAction = {
          holder: "andon.user",
          quantity: "0.500000000 LIQSOL",
          max_fee: String((amount * feeBps) / 10_000n + flatFee)
        },
        stdout = JSON.stringify({
          transaction_id: TransactionId,
          processed: {
            id: TransactionId,
            receipt: null,
            except: {
              code: 3050003,
              name: "sysio_assert_message_exception",
              message: "sysio_assert_message assertion failure",
              stack: [{ msg: `assertion failure with message: ${refusal}` }]
            }
          }
        }),
        error = enrichClioError(
          clioFailure("", { stdout, code: 19, killed: false, signal: null }),
          stdout,
          ""
        ),
        send = jest.spyOn(client["runner"], "run").mockRejectedValue(error),
        wait = jest.spyOn(client, "waitForTransactionInBlock"),
        result = client
          .getSysioContract(SysioContracts.SysioContractName.synd)
          .actions.desyndicate.invoke(data, {
            authorization: WireClient.activeAuthorization(data.holder)
          })
      await expect(result).rejects.toBe(error)
      await expect(result).rejects.toThrow(refusal)
      expect(send).toHaveBeenCalledTimes(WireClient.PushMaxAttempts)
      expect(wait).not.toHaveBeenCalled()
    })

    it("rejects a failed trace clio push transaction printed with exit 0, without waiting for it", async () => {
      const refusal = "TWAP window must be at least 60 seconds",
        stdout = JSON.stringify({
          transaction_id: TransactionId,
          processed: {
            id: TransactionId,
            receipt: null,
            scheduled: false,
            except: {
              code: 3050003,
              name: "sysio_assert_message_exception",
              message: "sysio_assert_message assertion failure",
              stack: [{ msg: `assertion failure with message: ${refusal}` }]
            }
          }
        }),
        dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wireclient-trace-")),
        runs = Path.join(dir, "runs"),
        binary = Path.join(dir, "clio")
      Fs.writeFileSync(
        binary,
        `#!/usr/bin/env bash\necho run >> '${runs}'\necho '${stdout}'\n`,
        { mode: 0o755 }
      )
      try {
        const client = new WireClient({ ...config, binary }),
          wait = jest.spyOn(client, "waitForTransactionInBlock"),
          data: SysioContracts.SysioKickerSetconfigAction = {
            cfg: {
              budget_remaining: "1000000000000000",
              min_interval_sec: 60,
              twap_window_sec: 59,
              max_spot_deviation_bps: 5000
            }
          },
          setconfig = client
            .getSysioContract(SysioContracts.SysioContractName.kicker)
            .actions.setconfig.prepare(data, {
              authorization: WireClient.activeAuthorization("sysio")
            })
        await expect(client.invokeTransaction(setconfig)).rejects.toThrow(refusal)
        expect(wait).not.toHaveBeenCalled()
        expect(
          Fs.readFileSync(runs, "utf-8").trim().split("\n")
        ).toHaveLength(WireClient.PushMaxAttempts)
      } finally {
        Fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it("skips the wait entirely for the settled-no-op sentinel", async () => {
      const client = new WireClient(config),
        send = jest.spyOn(client["runner"], "run").mockResolvedValue({
          transaction_id: WireClient.NoTransactionSentTransactionId
        } as never),
        wait = jest.spyOn(client, "waitForTransactionInBlock")

      await expect(
        client.createAccount("sysio", "sysio.acct", "PUB_K1_x", "PUB_K1_x")
      ).resolves.toBeDefined()
      expect(send).toHaveBeenCalledTimes(1)
      // Previously this polled a FAKE id for the whole budget, then re-ran the
      // command up to FinalityMaxAttempts times on an idempotent redeploy.
      expect(wait).not.toHaveBeenCalled()
    })
  })

  describe("getSysioContract proxy", () => {
    const epochClient = () =>
      new WireClient(config).getSysioContract(
        SysioContracts.SysioContractName.epoch
      )

    it("resolves a known action to an invoker", () => {
      const epoch = epochClient()
      expect(typeof epoch.actions.advance.prepare).toBe("function")
      expect(typeof epoch.actions.advance.invoke).toBe("function")
    })

    it("throws on an unknown action", () => {
      expect(() => Reflect.get(epochClient().actions, "bogus")).toThrow(
        /Unknown sysio\.epoch action: bogus/
      )
    })

    it("resolves a known table to a query", () => {
      expect(typeof epochClient().tables.epochstate.query).toBe("function")
    })

    it("throws on an unknown table", () => {
      expect(() => Reflect.get(epochClient().tables, "bogus")).toThrow(
        /Unknown sysio\.epoch table: bogus/
      )
    })

    it("prepare() builds an ActionPayload with the contract account + default auth", () => {
      const payload = epochClient().actions.advance.prepare({})
      expect(payload.account).toBe("sysio.epoch")
      expect(payload.name).toBe("advance")
      expect(payload.authorization).toEqual([
        { actor: "sysio.epoch", permission: "active" }
      ])
    })

    it("resolves the system contract account override to 'sysio'", () => {
      const payload = new WireClient(config)
        .getSysioContract(SysioContracts.SysioContractName.system)
        .actions.init.prepare({
          version: 0,
          core: Constants.CORE_SYMBOL_SPECIFICATION
        })
      expect(payload.account).toBe("sysio")
    })
  })

  describe("claimable reads", () => {
    // Two defects lived in these two lines. First the bound was the bare account name, which the
    // node cannot parse as JSON. Then, with that fixed, lower == upper described an EMPTY range:
    // chain_plugin breaks on `kv >= ub_sv`, so the row can never come back and the flow's poll
    // times out instead of erroring. Both were only reachable from flow-swap-to-wire.
    const rowsFor = (client: WireClient, captured: any[]) =>
      jest
        .spyOn(client, "getTableRows")
        .mockImplementation(async (query: any) => {
          captured.push(query)
          return {
            rows: [{ account_name: "wirercpt", balance: "1234" }],
            more: false
          } as never
        })

    it("sends a lower bound and NO upper bound", async () => {
      const client = new WireClient(config),
        captured: any[] = []
      rowsFor(client, captured)
      await client.getPayClaimable("wirercpt")
      const [query] = captured
      expect(query.lowerBound).toBe(
        WireClient.nameKeyBound("account_name", "wirercpt")
      )
      expect(query.upperBound).toBeUndefined()
    })

    it("returns the balance when the row belongs to the account", async () => {
      const client = new WireClient(config)
      rowsFor(client, [])
      expect(await client.getPayClaimable("wirercpt")).toBe(1234n)
    })

    it("returns 0n when the walk lands on the NEXT account's row", async () => {
      // lower_bound returns the first row at-or-after the key, so an account with no row reads
      // back a stranger's. Without the identity check this reported someone else's balance.
      const client = new WireClient(config)
      jest.spyOn(client, "getTableRows").mockResolvedValue({
        rows: [{ account_name: "wireother", balance: "999" }],
        more: false
      } as never)
      expect(await client.getPayClaimable("wirercpt")).toBe(0n)
    })

    it("returns 0n when the table has no rows at all", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client, "getTableRows")
        .mockResolvedValue({ rows: [], more: false } as never)
      expect(await client.getPayClaimable("wirercpt")).toBe(0n)
    })

    it("reads payclaims through its own key + row field names", async () => {
      const client = new WireClient(config),
        captured: any[] = []
      jest
        .spyOn(client, "getTableRows")
        .mockImplementation(async (query: any) => {
          captured.push(query)
          return {
            rows: [{ account_name: "wirercpt", balance: "77" }],
            more: false
          } as never
        })
      expect(await client.getPayClaimable("wirercpt")).toBe(77n)
      expect(captured[0].table).toBe("payclaims")
      expect(captured[0].lowerBound).toBe(
        WireClient.nameKeyBound("account_name", "wirercpt")
      )
    })
  })

  describe("nameKeyBound", () => {
    // The node parses a json=true bound with fc::json::from_string and encodes it via
    // be_key_codec::encode_key, which does .get_object() and looks each key field up BY NAME.
    // Passing the bare account string made nodeop fail at parse time with
    // `parse_error_exception: Unexpected char '119' in "wirercpt"` — 'w', the first character of
    // the name — which is what took flow-swap-to-wire's recipient-paid-exact step down.
    it("emits a JSON object keyed by the ABI key field, not the bare account", () => {
      const bound = WireClient.nameKeyBound("account", "wirercpt")
      expect(bound).not.toBe("wirercpt")
      const parsed = JSON.parse(bound)
      expect(Object.keys(parsed)).toEqual(["account"])
    })

    it("carries the name's raw uint64 as a decimal string", () => {
      // key_types is ["uint64"], and a name's raw value exceeds Number.MAX_SAFE_INTEGER, so it
      // must not ride as a JSON number.
      const { account } = JSON.parse(
        WireClient.nameKeyBound("account", "wirercpt")
      )
      expect(typeof account).toBe("string")
      expect(account).toMatch(/^[0-9]+$/)
      expect(BigInt(account)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    })

    it("honours the per-table key field name", () => {
      // wireclaims keys on `account`; payclaims keys on `account_name`. One helper, two shapes.
      expect(
        Object.keys(
          JSON.parse(WireClient.nameKeyBound("account_name", "wirercpt"))
        )
      ).toEqual(["account_name"])
    })

    it("round-trips distinct accounts to distinct bounds", () => {
      expect(WireClient.nameKeyBound("account", "wirercpt")).not.toBe(
        WireClient.nameKeyBound("account", "acct.aaa")
      )
    })
  })

  describe("symbolCodeKeyRange", () => {
    // sysio.liq's symbol-keyed KV tables (stat, liqpending, yieldidx) key on ONE uint64
    // `symbol_code`. The node takes `lower_bound` inclusive and `upper_bound` EXCLUSIVE, and a
    // bare code string fails at parse time (`Unexpected char '76' in "LIQSOL"`) exactly like a
    // bare account name does — which is what took flow-liq-yield's first yield read down.
    it("spans exactly [code, code + 1) as JSON objects keyed by the ABI key field", () => {
      const { lowerBound, upperBound } = WireClient.symbolCodeKeyRange(
          "symbol_code",
          "LIQSOL"
        ),
        lower = JSON.parse(lowerBound),
        upper = JSON.parse(upperBound)
      expect(Object.keys(lower)).toEqual(["symbol_code"])
      expect(Object.keys(upper)).toEqual(["symbol_code"])
      expect(typeof lower.symbol_code).toBe("string")
      expect(BigInt(upper.symbol_code)).toBe(BigInt(lower.symbol_code) + 1n)
    })

    it("carries the code's raw uint64, so two codes' ranges never overlap", () => {
      const at = (bound: string): bigint =>
          BigInt(JSON.parse(bound).symbol_code),
        sol = WireClient.symbolCodeKeyRange("symbol_code", "LIQSOL"),
        eth = WireClient.symbolCodeKeyRange("symbol_code", "LIQETH")
      expect(at(sol.lowerBound)).not.toBe(at(eth.lowerBound))
      expect(
        at(sol.lowerBound) >= at(eth.upperBound) ||
          at(sol.upperBound) <= at(eth.lowerBound)
      ).toBe(true)
    })

    it("refuses a code that is not a symbol code", () => {
      expect(() =>
        WireClient.symbolCodeKeyRange("symbol_code", "liqsol")
      ).toThrow()
    })
  })

  describe("transaction expiration", () => {
    it("pins an expiration well above clio's 30s default", () => {
      // clio's default is the SIGN->INCLUSION window, not execution. On a large
      // cluster the push must relay to whichever producer holds the slot, so 30s
      // left no margin and a bootstrap lost schbatchgps to expired_tx_exception.
      expect(WireClient.TransactionExpirationSec).toBeGreaterThan(30)
    })

    it("passes --expiration on every pushed action", async () => {
      const client = new WireClient(config)
      const args: string[][] = []
      jest
        .spyOn(ClioRunner.prototype, "run")
        .mockImplementation(async (runArgs: string[]) => {
          args.push(runArgs)
          return { transaction_id: "abc" } as never
        })
      await client.invoke(
        "sysio.epoch",
        "schbatchgps",
        {},
        [{ actor: "sysio.epoch", permission: "active" }],
        { skipWait: true }
      )
      expect(args[0]).toEqual(
        expect.arrayContaining([
          "--expiration",
          String(WireClient.TransactionExpirationSec)
        ])
      )
    })
  })

  describe("getBlockTrace", () => {
    afterEach(() => jest.restoreAllMocks())

    const block: WireClient.GetBlockTraceResponse = {
      number: 12,
      status: WireClient.BlockTraceStatus.irreversible,
      transactions: []
    }

    it("posts the block number to the trace API and returns the traced block", async () => {
      const post = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response(JSON.stringify(block)))

      await expect(new WireClient(config).getBlockTrace(12)).resolves.toEqual(block)
      expect(post).toHaveBeenCalledWith(
        `${config.nodeopUrl}/v1/trace_api/get_block`,
        expect.objectContaining({ body: JSON.stringify({ block_num: 12 }) })
      )
    })

    it("returns null for a block the node has not traced", async () => {
      jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response(null, { status: 404 }))

      await expect(new WireClient(config).getBlockTrace(12)).resolves.toBeNull()
    })

    it("fails on any other error status", async () => {
      jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response(null, { status: 500 }))

      await expect(new WireClient(config).getBlockTrace(12)).rejects.toThrow(
        "get_block_trace(12) failed: HTTP 500"
      )
    })
  })

  describe("decodeTraceActionData", () => {
    const { Abi } = NewAccountTraceFixture

    /** An ABI reader answering with the `newaccount` ABI. */
    function abiReader() {
      return { getAbi: jest.fn().mockResolvedValue(Abi) }
    }

    /** `trace` read as `sysio::newaccount` through `abis`. */
    function decode(
      abis: ReturnType<typeof abiReader>,
      trace: WireClient.TraceAction
    ): Promise<SysioContracts.SysioSystemNewaccountAction> {
      return WireClient.decodeTraceActionData(
        abis,
        SysioContracts.SysioContractName.system,
        NewAccountTraceFixture.Action,
        trace
      )
    }

    it("returns the node's decoded params without reading the ABI", async () => {
      const abis = abiReader()
      await expect(decode(abis, NewAccountTraceFixture.decoded("alice"))).resolves.toEqual(
        NewAccountTraceFixture.data("alice")
      )
      expect(abis.getAbi).not.toHaveBeenCalled()
    })

    it("decodes the encoded data with the contract's ABI when the node did not decode it", async () => {
      const abis = abiReader()
      await expect(decode(abis, NewAccountTraceFixture.raw("alice"))).resolves.toEqual(
        NewAccountTraceFixture.data("alice")
      )
      expect(abis.getAbi).toHaveBeenCalledTimes(1)
      expect(String(abis.getAbi.mock.calls[0][0])).toBe("sysio")
    })

    it("fails, keeping the cause, when the data does not decode", async () => {
      const trace = NewAccountTraceFixture.raw("alice"),
        failure = await decode(abiReader(), { ...trace, data: trace.data.slice(0, -2) }).then(
          () => null,
          identity<NestedError>
        )
      expect(failure).toBeInstanceOf(NestedError)
      expect(failure.message).toMatch(
        /^a trace of sysio::newaccount carries no decoded params, and its data does not decode with the sysio ABI/
      )
      expect(failure.context).toEqual({ data: trace.data.slice(0, -2) })
      expect(failure.causes).toHaveLength(1)
    })

    it("fails when the ABI does not declare the action", async () => {
      const abis = { getAbi: jest.fn().mockResolvedValue({ ...Abi, actions: [] }) }
      await expect(decode(abis, NewAccountTraceFixture.raw("alice"))).rejects.toThrow(
        /does not decode with the sysio ABI/
      )
    })

    it("refuses a trace of another action, reading no ABI", async () => {
      const abis = abiReader()
      await expect(
        decode(abis, { ...NewAccountTraceFixture.raw("alice"), name: "updateauth" })
      ).rejects.toThrow("a trace of sysio::updateauth is not sysio::newaccount")
      expect(abis.getAbi).not.toHaveBeenCalled()
    })
  })

  describe("getTransactionId", () => {
    it("extracts from an object", () => {
      expect(WireClient.getTransactionId({ transaction_id: "abc" })).toBe("abc")
    })
    it("extracts from a JSON string", () => {
      expect(WireClient.getTransactionId('{"transaction_id":"def"}')).toBe(
        "def"
      )
    })
    it("extracts from raw text via regex", () => {
      expect(
        WireClient.getTransactionId('noise "transaction_id": "0123abcd" noise')
      ).toBe("0123abcd")
    })
    it("returns null when absent", () => {
      expect(WireClient.getTransactionId({})).toBeNull()
      expect(WireClient.getTransactionId("nope")).toBeNull()
    })
  })

  describe("blockContainsTransaction", () => {
    const block: WireClient.GetBlockResponse = {
      block_num: 1,
      id: "block-id",
      transactions: [
        { status: "executed", trx: { id: "tx1" } },
        { status: "executed", trx: "tx2" }
      ]
    }

    it("matches both object and string trx forms", () => {
      expect(WireClient.blockContainsTransaction(block, "tx1")).toBe(true)
      expect(WireClient.blockContainsTransaction(block, "tx2")).toBe(true)
    })
    it("is false when absent", () => {
      expect(WireClient.blockContainsTransaction(block, "tx3")).toBe(false)
    })
  })

  describe("activeAuthorization", () => {
    it("is <account>@active — the ONE spelling every self-signed action derives", () => {
      expect(WireClient.ActivePermission).toBe("active")
      expect(WireClient.activeAuthorization("defproducera")).toEqual([
        { actor: "defproducera", permission: "active" }
      ])
    })

    it("is the invoker's default authorization, on the contract account", () => {
      const payload = new WireClient(config)
        .getSysioContract(SysioContracts.SysioContractName.system)
        .actions.regproducer.prepare({
          producer: "defproducera",
          producer_key: "PUB_K1_p",
          url: "",
          location: 0
        })
      expect(payload.authorization).toEqual(
        WireClient.activeAuthorization("sysio")
      )
    })
  })

  describe("paged table reads", () => {
    const query: WireClient.TableRowsQuery = {
        account: "sysio.dclaim",
        scope: "sysio.dclaim",
        table: "unmapped",
        limit: 2
      },
      kvRow = (id: number) => ({ key: { id }, value: { id } }),
      page = (ids: number[], nextKey: string) => ({
        rows: ids.map(kvRow),
        more: nextKey != null,
        next_key: nextKey
      })

    it("getTableRows passes the node's next_key through as the next page's bound", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client.api.v1.chain, "get_table_rows")
        .mockResolvedValue(page([1, 2], `{"id":3}`) as never)
      expect(await client.getTableRows(query)).toEqual({
        rows: [{ id: 1 }, { id: 2 }],
        more: true,
        nextKey: `{"id":3}`
      })
    })

    it("getAllTableRows resumes each page at the previous page's next_key", async () => {
      const client = new WireClient(config),
        read = jest
          .spyOn(client.api.v1.chain, "get_table_rows")
          .mockResolvedValueOnce(page([1, 2], `{"id":3}`) as never)
          .mockResolvedValueOnce(page([3, 4], `{"id":5}`) as never)
          .mockResolvedValueOnce(page([5], undefined) as never)
      expect(await client.getAllTableRows(query)).toEqual(
        [1, 2, 3, 4, 5].map(id => ({ id }))
      )
      expect(
        read.mock.calls.map(([params]: any[]) => params.lower_bound)
      ).toEqual([undefined, `{"id":3}`, `{"id":5}`])
    })

    it("getAllTableRows refuses a page with more rows but no resume key", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client.api.v1.chain, "get_table_rows")
        .mockResolvedValue({ rows: [kvRow(1)], more: true } as never)
      await expect(client.getAllTableRows(query)).rejects.toThrow(
        /sysio\.dclaim::unmapped reported more rows but no resume key/
      )
    })

    it("getAllTableRows refuses a resume key that does not move past its own bound", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client.api.v1.chain, "get_table_rows")
        .mockResolvedValue(page([3], `{"id":3}`) as never)
      await expect(
        client.getAllTableRows({ ...query, lowerBound: `{"id":3}` })
      ).rejects.toThrow(/no resume key past \{"id":3\}/)
    })

    it("queryAll reads the contract's table in its own scope through getAllTableRows", async () => {
      const client = new WireClient(config),
        all = jest.spyOn(client, "getAllTableRows").mockResolvedValue([])
      await client
        .getSysioContract(SysioContracts.SysioContractName.dclaim)
        .tables.unmapped.queryAll({ limit: 500 })
      expect(all).toHaveBeenCalledWith(
        expect.objectContaining({
          account: "sysio.dclaim",
          scope: "sysio.dclaim",
          table: "unmapped",
          limit: 500
        })
      )
    })
  })

  describe("typed table getters", () => {
    it("getProducers reads sysio::producers through the typed accessor", async () => {
      const client = new WireClient(config),
        rows = jest
          .spyOn(client, "getTableRows")
          .mockResolvedValue({ rows: [], more: false } as never)
      await client.getProducers()
      expect(rows).toHaveBeenCalledWith(
        expect.objectContaining({
          account: "sysio",
          scope: "sysio",
          table: "producers"
        })
      )
    })
  })

  describe("isPrivileged", () => {
    it("reads get_account's privileged flag for the named account", async () => {
      const client = new WireClient(config),
        getAccount = jest
          .spyOn(client.api.v1.chain, "get_account")
          .mockResolvedValue({ privileged: true } as never)
      expect(await client.isPrivileged("sysio.kicker")).toBe(true)
      expect(getAccount).toHaveBeenCalledWith("sysio.kicker")
    })

    it("is false for an unprivileged account", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client.api.v1.chain, "get_account")
        .mockResolvedValue({ privileged: false } as never)
      expect(await client.isPrivileged("alice")).toBe(false)
    })
  })

  describe("toAuthorityType", () => {
    /**
     * A decoded authority. The test's sdk-core types resolve to the ESM declarations and the
     * client's to the CJS ones, so the instance crosses into the client as the client's own
     * `Authority`; at run time both are the one CJS module.
     */
    function decoded(
      authority: Parameters<typeof Authority.from>[0]
    ): Parameters<typeof WireClient.toAuthorityType>[0] {
      return Authority.from(authority) as never
    }

    it("spells a decoded authority as the generated type: plain numbers, string names and keys", () => {
      const key = PublicKey.from(Constants.DEV_K1_PUBLIC_KEY),
        authority = decoded({
          threshold: 2,
          keys: [{ key, weight: 1 }],
          accounts: [
            { permission: { actor: "sysio.nodes", permission: "active" }, weight: 1 }
          ]
        })
      expect(WireClient.toAuthorityType(authority)).toEqual({
        threshold: 2,
        keys: [{ key: key.toString(), weight: 1 }],
        accounts: [
          { permission: { actor: "sysio.nodes", permission: "active" }, weight: 1 }
        ]
      })
    })

    it("keeps an authority with neither keys nor accounts empty", () => {
      expect(WireClient.toAuthorityType(decoded({ threshold: 1 }))).toEqual({
        threshold: 1,
        keys: [],
        accounts: []
      })
    })
  })

  it("spells the root permission's parent empty", () => {
    expect(WireClient.OwnerParent).toBe("")
  })

  describe("getRamQuota", () => {
    it("reads get_account's ram_quota for the named account as a number", async () => {
      const client = new WireClient(config),
        getAccount = jest
          .spyOn(client.api.v1.chain, "get_account")
          .mockResolvedValue({ ram_quota: "5432" } as never)
      expect(await client.getRamQuota("sysio.andon")).toBe(5432)
      expect(getAccount).toHaveBeenCalledWith("sysio.andon")
    })

    it("reports an unlimited account as -1", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client.api.v1.chain, "get_account")
        .mockResolvedValue({ ram_quota: -1 } as never)
      expect(await client.getRamQuota("sysio")).toBe(-1)
    })
  })

  describe("grantRam", () => {
    /** A client whose RAM read and `setacctram` push are doubled at their seams. */
    function grantClient(ramQuota: number) {
      const client = new WireClient(config),
        system = client.getSysioContract(SysioContracts.SysioContractName.system),
        setacctram = jest
          .spyOn(system.actions.setacctram, "invoke")
          .mockResolvedValue(undefined)
      jest.spyOn(client, "getRamQuota").mockResolvedValue(ramQuota)
      jest.spyOn(client, "getSysioContract").mockReturnValue(system as never)
      return { client, setacctram }
    }

    afterEach(() => jest.restoreAllMocks())

    it("sets the limit to the current quota plus the grant, as sysio", async () => {
      const { client, setacctram } = grantClient(250_000)
      await client.grantRam("sysio.andon", 10_400)
      expect(setacctram).toHaveBeenCalledTimes(1)
      // No authorization override: the invoker signs as the contract account, `sysio@active`.
      expect(setacctram).toHaveBeenCalledWith({
        account: "sysio.andon",
        ram_bytes: 260_400
      })
    })

    it("refuses an account with an unlimited RAM limit", async () => {
      const { client, setacctram } = grantClient(-1)
      await expect(client.grantRam("sysio", 10_400)).rejects.toThrow(
        /unlimited RAM limit/
      )
      expect(setacctram).not.toHaveBeenCalled()
    })

    it.each([0, -1, 1.5])("refuses a grant of %p bytes", async ramBytes => {
      const { client, setacctram } = grantClient(250_000)
      await expect(client.grantRam("sysio.andon", ramBytes)).rejects.toThrow(
        /positive byte count/
      )
      expect(setacctram).not.toHaveBeenCalled()
    })
  })

  describe("encoded actions", () => {
    /**
     * An already-encoded `sysio.councl::syncnodes` (its data is the caller's name). The test
     * build types sdk-core from its ESM declarations and the source from its CJS ones, so the
     * instance crosses into the client as the client's own `Action`; at run time both are the
     * one CJS module.
     */
    function encodedSyncnodes(): Parameters<typeof WireClient.toEncodedActionJson>[0] {
      return Action.from({
        account: "sysio.councl",
        name: "syncnodes",
        authorization: [{ actor: "sysio", permission: "active" }],
        data: Name.from("sysio").value.byteArray
      }) as never
    }

    afterEach(() => jest.restoreAllMocks())

    it("spells an encoded action as clio's push form with hex data", () => {
      const action = encodedSyncnodes()
      expect(WireClient.toEncodedActionJson(action)).toEqual({
        account: "sysio.councl",
        name: "syncnodes",
        authorization: [{ actor: "sysio", permission: "active" }],
        data: action.data.hexString
      })
    })

    it("pushes encoded and typed actions as ONE transaction, in order", async () => {
      const client = new WireClient(config),
        send = jest.spyOn(client["runner"], "run").mockResolvedValue({
          transaction_id: WireClient.NoTransactionSentTransactionId
        } as never),
        typed = client
          .getSysioContract(SysioContracts.SysioContractName.system)
          .actions.updateauth.prepare(
            {
              account: "sysio",
              permission: "active",
              parent: "owner",
              auth: { threshold: 1, keys: [], accounts: [] }
            },
            { authorization: WireClient.activeAuthorization("sysio") }
          ),
        action = encodedSyncnodes()
      await client.invokeTransaction(action, typed)
      expect(send).toHaveBeenCalledTimes(1)
      const [args] = send.mock.calls[0] as [string[]],
        { actions } = JSON.parse(args[args.indexOf("-j") + 1])
      expect(actions).toHaveLength(2)
      expect(actions[0]).toEqual(WireClient.toEncodedActionJson(action))
      expect(actions[1]).toMatchObject({ account: "sysio", name: "updateauth" })
    })
  })

  describe("getProducerSchedule", () => {
    it("projects sdk-core's Name-typed entries onto plain producer names, in slot order", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client.api.v1.chain, "get_producer_schedule")
        .mockResolvedValue({
          active: {
            version: 3,
            producers: [
              { producer_name: "defproducera" },
              { producer_name: "defproducerb" }
            ]
          },
          pending: { version: 4, producers: [{ producer_name: "flowprod" }] }
        } as never)
      const schedule = await client.getProducerSchedule()
      expect(schedule.active).toEqual({
        version: 3,
        producers: ["defproducera", "defproducerb"]
      })
      expect(schedule.pending).toEqual({ version: 4, producers: ["flowprod"] })
      // No proposed schedule in flight → nothing is invented for it.
      expect(schedule.proposed).toBeUndefined()
    })
  })

  // A KMS-custodied WIRE K1 never enters kiod, so a push its account authorizes is built,
  // signed and sent through sdk-core instead of clio — behind the SAME finality wait and the
  // same re-push rule. Every key below is generated for the test and discarded.
  describe("signer-routed pushes (addSigner)", () => {
    const Operator = "batchop.a",
      OtherOperator = "batchop.b",
      TransactionId =
        "9c1f0e2a4b6d8f1032547698badcfe10112233445566778899aabbccddeeff00",
      BlockNum = 268,
      ChainTime = "2026-11-12T00:00:00.000",
      /** The path `APIClient.pushTransaction` submits at — the roster's first entry. */
      [PushPath] = WireClient.TransactionSubmissionPaths,
      /** The two chain-API reads sdk-core makes while BUILDING a transaction, before it submits. */
      BuildPath = {
        getInfo: "/v1/chain/get_info",
        getAbi: "/v1/chain/get_abi"
      } as const,
      /** A 32-byte id a fixture needs somewhere — a chain id, a block id. */
      ZeroId = "0".repeat(64)

    afterEach(() => jest.restoreAllMocks())

    /**
     * `addSigner`'s parameter type, read off the client: the test build resolves
     * `@wireio/sdk-core` to its ESM declarations while `src/` resolves the CJS ones — two
     * copies of `SignerProvider` whose `PublicKey` carries private members — so a signer
     * minted here is bridged to the client's copy through `unknown`, the way the other
     * suites bridge a signer double.
     */
    type RegisteredSigner = Parameters<WireClient["addSigner"]>[1]

    /** A throwaway K1 signer: generated here, never persisted, never printed. */
    function newSigner(): RegisteredSigner {
      return createClassicSigner(
        PrivateKey.generate(KeyType.K1)
      ) as unknown as RegisteredSigner
    }

    /** `sysio::claimpay` for `account` — the shape of a push an operator signs itself. */
    function claimPay(
      account: string
    ): SysioContracts.SysioSystemClaimpayAction {
      return { account_name: account }
    }

    /** sdk-core's `push_transaction` answer — the id is what `withFinality` follows. */
    function pushResponse(): API.v1.PushTransactionResponse {
      return {
        transaction_id: TransactionId,
        processed: {
          id: TransactionId,
          block_num: BlockNum,
          block_time: ChainTime,
          receipt: { status: "executed", cpu_usage_us: 1, net_usage_words: 1 },
          elapsed: 1,
          net_usage: 8,
          scheduled: false,
          action_traces: [],
          account_ram_delta: null
        }
      }
    }

    /** `withFinality` sees the transaction land in `BlockNum`, which is already irreversible. */
    function irreversibleAtBlock(client: WireClient) {
      const wait = jest
        .spyOn(client, "waitForTransactionInBlock")
        .mockResolvedValue(BlockNum)
      jest.spyOn(client, "getInfo").mockResolvedValue({
        server_version: "0",
        chain_id: ZeroId,
        head_block_num: BlockNum,
        last_irreversible_block_num: BlockNum,
        head_block_time: ChainTime,
        head_block_id: ZeroId,
        head_block_producer: "sysio"
      })
      jest.spyOn(client, "getBlock").mockResolvedValue({
        block_num: BlockNum,
        id: ZeroId,
        transactions: [{ status: "executed", trx: { id: TransactionId } }]
      })
      return wait
    }

    /** sdk-core's wrapping of the node refusing a call at `path` with a reply carrying no error body. */
    function buildFailure(path: string): NestedError {
      return new NestedError(`HTTP 503 at ${path}`, {
        cause: new APIError(path, { status: 503, headers: {}, text: "" })
      })
    }

    /** sdk-core's wrapping of the node answering `path` (the submission by default) with chain code `code`. */
    function nodeRejection(
      code: number,
      reason: string,
      path: string = PushPath
    ): NestedError {
      const json = {
        code: 500,
        message: "Internal Service Error",
        error: {
          code,
          name: "sysio_assert_message_exception",
          what: "assertion failure",
          details: [
            {
              message: `assertion failure with message: ${reason}`,
              file: "wasm_interface.cpp",
              line_number: 1,
              method: "sysio_assert"
            }
          ]
        }
      }
      return new NestedError(reason, {
        cause: new APIError(path, {
          status: 500,
          headers: {},
          json,
          text: JSON.stringify(json)
        })
      })
    }

    /** sdk-core's wrapping of a fetch that failed with Node system error `code`. */
    function transportFailure(code: string): NestedError {
      return new NestedError("pushTransaction failed", {
        cause: new TypeError("fetch failed", {
          cause: Object.assign(new Error(`connect ${code}`), { code })
        })
      })
    }

    it("sends a push whose actor is registered through its own sdk-core client, never clio", async () => {
      const client = new WireClient(config),
        signer = newSigner(),
        response = pushResponse(),
        push = jest
          .spyOn(APIClient.prototype, "pushTransaction")
          .mockResolvedValue(response),
        run = jest.spyOn(ClioRunner.prototype, "run"),
        authorization = WireClient.activeAuthorization(Operator)
      client.addSigner(Operator, signer)
      await expect(
        client.invoke("sysio", "claimpay", claimPay(Operator), authorization, {
          skipWait: true
        })
      ).resolves.toBe(response)
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith({
        account: "sysio",
        name: "claimpay",
        authorization,
        data: claimPay(Operator)
      })
      // The registration's OWN client pushed, carrying exactly this signer — never `client.api`.
      const [pusher] = push.mock.contexts as APIClient[]
      expect(pusher).not.toBe(client.api)
      expect(pusher.signer).toBe(signer)
      expect(run).not.toHaveBeenCalled()
    })

    it("routes invokeViaFile the same way, writing no transaction file", async () => {
      const client = new WireClient(config),
        response = pushResponse(),
        push = jest
          .spyOn(APIClient.prototype, "pushTransaction")
          .mockResolvedValue(response),
        run = jest.spyOn(ClioRunner.prototype, "run"),
        writeFile = jest.spyOn(Fs.promises, "writeFile"),
        authorization = WireClient.activeAuthorization(Operator)
      client.addSigner(Operator, newSigner())
      await expect(
        client.invokeViaFile(
          "sysio",
          "claimpay",
          claimPay(Operator),
          authorization,
          { skipWait: true }
        )
      ).resolves.toBe(response)
      expect(push).toHaveBeenCalledWith({
        account: "sysio",
        name: "claimpay",
        authorization,
        data: claimPay(Operator)
      })
      expect(writeFile).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    })

    it("leaves a push whose actor has no signer on the clio + kiod path", async () => {
      const client = new WireClient(config),
        push = jest.spyOn(APIClient.prototype, "pushTransaction"),
        run = jest
          .spyOn(ClioRunner.prototype, "run")
          .mockResolvedValue({ transaction_id: TransactionId } as never)
      client.addSigner(Operator, newSigner())
      await client.invoke(
        "sysio",
        "claimpay",
        claimPay(OtherOperator),
        WireClient.activeAuthorization(OtherOperator),
        { skipWait: true }
      )
      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          "push",
          "action",
          "-p",
          `${OtherOperator}@active`
        ])
      )
      expect(push).not.toHaveBeenCalled()
    })

    it.each([
      [
        "a second actor",
        [
          { actor: Operator, permission: "active" },
          { actor: "sysio", permission: "active" }
        ]
      ],
      [
        "a second permission of the same account",
        [
          { actor: Operator, permission: "active" },
          { actor: Operator, permission: "owner" }
        ]
      ]
    ])(
      "refuses a push carrying %s once its actor is registered, sending nothing",
      async (_case, authorization) => {
        const client = new WireClient(config),
          push = jest.spyOn(APIClient.prototype, "pushTransaction"),
          run = jest.spyOn(ClioRunner.prototype, "run")
        client.addSigner(Operator, newSigner())
        await expect(
          client.invoke(
            "sysio",
            "claimpay",
            claimPay(Operator),
            authorization,
            { skipWait: true }
          )
        ).rejects.toThrow(/exactly one signature/)
        expect(push).not.toHaveBeenCalled()
        expect(run).not.toHaveBeenCalled()
      }
    )

    it("sends a multi-action transaction through the one registered account's signer", async () => {
      const client = new WireClient(config),
        response = pushResponse(),
        push = jest
          .spyOn(APIClient.prototype, "pushTransaction")
          .mockResolvedValue(response),
        run = jest.spyOn(ClioRunner.prototype, "run"),
        authorization = WireClient.activeAuthorization(Operator),
        claim = client
          .getSysioContract(SysioContracts.SysioContractName.system)
          .actions.claimpay.prepare(claimPay(Operator), { authorization })
      irreversibleAtBlock(client)
      client.addSigner(Operator, newSigner())
      await expect(client.invokeTransaction(claim, claim)).resolves.toBe(
        response
      )
      expect(push).toHaveBeenCalledWith([
        {
          account: "sysio",
          name: "claimpay",
          authorization,
          data: claimPay(Operator)
        },
        {
          account: "sysio",
          name: "claimpay",
          authorization,
          data: claimPay(Operator)
        }
      ])
      expect(run).not.toHaveBeenCalled()
    })

    it("hands an encoded action to the registered signer as it is, beside a typed one", async () => {
      const client = new WireClient(config),
        response = pushResponse(),
        push = jest
          .spyOn(APIClient.prototype, "pushTransaction")
          .mockResolvedValue(response),
        run = jest.spyOn(ClioRunner.prototype, "run"),
        authorization = WireClient.activeAuthorization(Operator),
        claim = client
          .getSysioContract(SysioContracts.SysioContractName.system)
          .actions.claimpay.prepare(claimPay(Operator), { authorization }),
        // Typed as the client's own `Action` — see the "encoded actions" suite.
        encoded: Parameters<typeof WireClient.toEncodedActionJson>[0] = Action.from({
          account: "sysio.councl",
          name: "syncnodes",
          authorization: [{ actor: Operator, permission: WireClient.ActivePermission }],
          data: Name.from(Operator).value.byteArray
        }) as never
      irreversibleAtBlock(client)
      client.addSigner(Operator, newSigner())
      await expect(client.invokeTransaction(encoded, claim)).resolves.toBe(
        response
      )
      expect(push).toHaveBeenCalledTimes(1)
      const [[pushed]] = push.mock.calls as unknown as [[unknown[]]]
      expect(pushed[0]).toBe(encoded)
      expect(pushed[1]).toEqual({
        account: "sysio",
        name: "claimpay",
        authorization,
        data: claimPay(Operator)
      })
      expect(run).not.toHaveBeenCalled()
    })

    it("refuses a multi-action transaction that mixes a registered actor with another", async () => {
      const client = new WireClient(config),
        push = jest.spyOn(APIClient.prototype, "pushTransaction"),
        run = jest.spyOn(ClioRunner.prototype, "run"),
        system = client.getSysioContract(
          SysioContracts.SysioContractName.system
        ),
        signed = system.actions.claimpay.prepare(claimPay(Operator), {
          authorization: WireClient.activeAuthorization(Operator)
        }),
        // The invoker's default authorization: the contract account, signed by kiod.
        unsigned = system.actions.claimpay.prepare(claimPay(OtherOperator))
      client.addSigner(Operator, newSigner())
      await expect(client.invokeTransaction(signed, unsigned)).rejects.toThrow(
        /exactly one signature/
      )
      expect(push).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    })

    it("waits for the signer push's transaction to be irreversible, exactly as for a clio push", async () => {
      const client = new WireClient(config),
        response = pushResponse(),
        push = jest
          .spyOn(APIClient.prototype, "pushTransaction")
          .mockResolvedValue(response),
        wait = irreversibleAtBlock(client)
      client.addSigner(Operator, newSigner())
      await expect(
        client.invoke(
          "sysio",
          "claimpay",
          claimPay(Operator),
          WireClient.activeAuthorization(Operator)
        )
      ).resolves.toBe(response)
      expect(push).toHaveBeenCalledTimes(1)
      expect(wait).toHaveBeenCalledWith(TransactionId, expect.any(Number))
    })

    it("re-sends a signer push the node rejected, up to PushMaxAttempts, without entering finality", async () => {
      const client = new WireClient(config),
        reason = "Tier level must be between 1 and 3",
        push = jest
          .spyOn(APIClient.prototype, "pushTransaction")
          .mockRejectedValue(nodeRejection(3050003, reason)),
        wait = jest.spyOn(client, "waitForTransactionInBlock")
      client.addSigner(Operator, newSigner())
      await expect(
        client.invoke(
          "sysio",
          "claimpay",
          claimPay(Operator),
          WireClient.activeAuthorization(Operator)
        )
      ).rejects.toThrow(reason)
      expect(push).toHaveBeenCalledTimes(WireClient.PushMaxAttempts)
      expect(wait).not.toHaveBeenCalled()
    })

    it("re-sends a signer push whose build failed before anything was sent, then follows the second push", async () => {
      // `get_info` (TAPOS) refused on the first attempt: nothing was submitted, so the
      // retry is safe; the second attempt submits and its id is what finality follows.
      const client = new WireClient(config),
        response = pushResponse(),
        push = jest
          .spyOn(APIClient.prototype, "pushTransaction")
          .mockRejectedValueOnce(buildFailure(BuildPath.getInfo))
          .mockResolvedValueOnce(response),
        wait = irreversibleAtBlock(client)
      client.addSigner(Operator, newSigner())
      await expect(
        client.invoke(
          "sysio",
          "claimpay",
          claimPay(Operator),
          WireClient.activeAuthorization(Operator)
        )
      ).resolves.toBe(response)
      expect(push).toHaveBeenCalledTimes(2)
      expect(wait).toHaveBeenCalledTimes(1)
      expect(wait).toHaveBeenCalledWith(TransactionId, expect.any(Number))
    })

    it.each([ClioRunner.DuplicateTransactionCode, 3200000])(
      "never re-sends a signer push the node answered with the ambiguous code %s",
      async code => {
        const client = new WireClient(config),
          push = jest
            .spyOn(APIClient.prototype, "pushTransaction")
            .mockRejectedValue(nodeRejection(code, "ambiguous"))
        client.addSigner(Operator, newSigner())
        await expect(
          client.invoke(
            "sysio",
            "claimpay",
            claimPay(Operator),
            WireClient.activeAuthorization(Operator)
          )
        ).rejects.toThrow(/not re-sent/)
        expect(push).toHaveBeenCalledTimes(1)
      }
    )

    it("replaces the registration when an account's signer is added again", async () => {
      const client = new WireClient(config),
        first = newSigner(),
        second = newSigner(),
        push = jest
          .spyOn(APIClient.prototype, "pushTransaction")
          .mockResolvedValue(pushResponse())
      client.addSigner(Operator, first)
      client.addSigner(Operator, second)
      await client.invoke(
        "sysio",
        "claimpay",
        claimPay(Operator),
        WireClient.activeAuthorization(Operator),
        { skipWait: true }
      )
      const [pusher] = push.mock.contexts as APIClient[]
      expect(pusher.signer).toBe(second)
      expect(pusher.signer).not.toBe(first)
    })

    it.each([
      ["an empty account", "", newSigner()],
      [
        "a signer without its public key",
        Operator,
        { pubKey: null, sign: async () => new Uint8Array() }
      ]
    ])("refuses to register %s", (_case, account, signer) => {
      expect(() => new WireClient(config).addSigner(account, signer)).toThrow()
    })

    it("relies on sdk-core pinning the expiration this client pins on clio — the re-push proof's premise", () => {
      // `classifyUnresolved` proves a push can never apply once head time passes
      // pushedAt + TransactionExpirationSec; that is only true of a signer push because
      // sdk-core's default transaction header expires in the same 120 s.
      const info = API.v1.GetInfoResponse.from({
        server_version: "0",
        chain_id: ZeroId,
        head_block_num: BlockNum,
        last_irreversible_block_num: BlockNum,
        last_irreversible_block_id: ZeroId,
        head_block_id: ZeroId,
        head_block_time: ChainTime,
        head_block_producer: "sysio",
        virtual_block_cpu_limit: 1,
        virtual_block_net_limit: 1,
        block_cpu_limit: 1,
        block_net_limit: 1
      })
      expect(info.getTransactionHeader().expiration.toMilliseconds()).toBe(
        WireClient.chainTimeMs(ChainTime) +
          WireClient.TransactionExpirationSec * ProtocolTiming.MsPerSecond
      )
    })

    describe("isSignerPushProvenUnapplied", () => {
      it.each([
        [
          "the node's rejection",
          true,
          nodeRejection(3050003, "assertion failure")
        ],
        [
          "a rejection at the chain family's lower bound",
          true,
          nodeRejection(ClioRunner.ChainErrorCodeMinimum, "chain exception")
        ],
        [
          "tx_duplicate — the node already holds it",
          false,
          nodeRejection(
            ClioRunner.DuplicateTransactionCode,
            "duplicate transaction"
          )
        ],
        [
          "an http_exception-family code",
          false,
          nodeRejection(3200000, "http exception")
        ],
        [
          "a code outside the chain family",
          false,
          nodeRejection(
            ClioRunner.ChainErrorCodeMaximum + 1,
            "not a chain code"
          )
        ],
        [
          "a rejection at the roster's send_transaction2 path",
          true,
          nodeRejection(
            3050003,
            "assertion failure",
            WireClient.TransactionSubmissionPaths[2]
          )
        ],
        [
          "get_info refused while building the transaction",
          true,
          buildFailure(BuildPath.getInfo)
        ],
        [
          "get_abi refused while building the transaction, with no chain code",
          true,
          nodeRejection(0, "unknown key", BuildPath.getAbi)
        ],
        [
          "a submission answered with code 0",
          false,
          nodeRejection(0, "unknown key", PushPath)
        ],
        [
          "a submission answered 5xx without an error body",
          false,
          buildFailure(PushPath)
        ],
        [
          "a refused connection",
          true,
          transportFailure(WireClient.ConnectionFailureCode.ECONNREFUSED)
        ],
        [
          "an unresolvable host",
          true,
          transportFailure(WireClient.ConnectionFailureCode.ENOTFOUND)
        ],
        [
          "clio's refused-connection wording",
          true,
          new NestedError("pushTransaction failed", {
            cause: new Error("Connection refused")
          })
        ],
        ["a reset mid-reply", false, transportFailure("ECONNRESET")],
        [
          "the provider's request timeout",
          false,
          new NestedError("pushTransaction failed", {
            cause: new Error("FetchProvider request timed out after 60000 ms")
          })
        ],
        [
          "a signing failure",
          false,
          new NestedError("transaction signing failed", {
            cause: new Error("the KMS request was throttled")
          })
        ],
        ["an unrelated error", false, new Error("boom")],
        ["a non-error", false, "boom"]
      ])("%s: proven unapplied is %p", (_case, expected, error) => {
        expect(WireClient.isSignerPushProvenUnapplied(error)).toBe(expected)
      })

      it("survives a cause chain that loops", () => {
        const looped = new Error("loop")
        looped.cause = looped
        expect(WireClient.isSignerPushProvenUnapplied(looped)).toBe(false)
      })
    })

    describe("TransactionSubmissionPaths", () => {
      it("names exactly the chain-API paths that submit a transaction", () => {
        // sdk-core's `ChainAPI` posts a signed transaction at these three and nowhere else;
        // every other path an `APIError` names was a BUILD read (`get_abi`, `get_info`).
        expect(WireClient.TransactionSubmissionPaths).toEqual([
          "/v1/chain/push_transaction",
          "/v1/chain/send_transaction",
          "/v1/chain/send_transaction2"
        ])
        expect(WireClient.TransactionSubmissionPaths).not.toContain(
          BuildPath.getInfo
        )
        expect(WireClient.TransactionSubmissionPaths).not.toContain(
          BuildPath.getAbi
        )
      })
    })

    describe("isProvenUnapplied", () => {
      it("accepts clio's evidence and a signer push's alike, and nothing else", () => {
        const clioRejection = Object.assign(
          new Error("Command failed: clio\nError 3050003: assertion failure"),
          { stderr: "Error 3050003: assertion failure" }
        )
        expect(WireClient.isProvenUnapplied(clioRejection)).toBe(true)
        expect(
          WireClient.isProvenUnapplied(
            nodeRejection(3050003, "assertion failure")
          )
        ).toBe(true)
        expect(WireClient.isProvenUnapplied(new Error("boom"))).toBe(false)
      })
    })
  })
})

describe("WireClient.chainTimeMs", () => {
  it("reads a zone-less chain stamp as UTC", () => {
    expect(WireClient.chainTimeMs("2026-09-30T00:00:01.500")).toBe(
      Date.UTC(2026, 8, 30, 0, 0, 1, 500)
    )
  })

  it("accepts a stamp that already carries the Z", () => {
    expect(WireClient.chainTimeMs("2026-09-30T00:00:01.500Z")).toBe(
      WireClient.chainTimeMs("2026-09-30T00:00:01.500")
    )
  })

  it("answers NaN for a stamp that is not a time", () => {
    expect(WireClient.chainTimeMs("not a time")).toBeNaN()
  })
})
