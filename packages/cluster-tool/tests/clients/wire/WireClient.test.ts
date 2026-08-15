import Os from "node:os"
import Path from "node:path"
import { SysioContracts } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool/Constants"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import {
  ClioRunner,
  WireClient,
  type WireClientConfig
} from "@wireio/cluster-tool/clients/wire"
import { toURL } from "@wireio/cluster-tool/utils"

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
          return { rows: [{ account: "wirercpt", balance: "1234" }], more: false } as never
        })

    it("sends a lower bound and NO upper bound", async () => {
      const client = new WireClient(config),
        captured: any[] = []
      rowsFor(client, captured)
      await client.getWireClaimable("wirercpt")
      const [query] = captured
      expect(query.lowerBound).toBe(WireClient.nameKeyBound("account", "wirercpt"))
      expect(query.upperBound).toBeUndefined()
    })

    it("returns the balance when the row belongs to the account", async () => {
      const client = new WireClient(config)
      rowsFor(client, [])
      expect(await client.getWireClaimable("wirercpt")).toBe(1234n)
    })

    it("returns 0n when the walk lands on the NEXT account's row", async () => {
      // lower_bound returns the first row at-or-after the key, so an account with no row reads
      // back a stranger's. Without the identity check this reported someone else's balance.
      const client = new WireClient(config)
      jest
        .spyOn(client, "getTableRows")
        .mockResolvedValue({
          rows: [{ account: "wireother", balance: "999" }],
          more: false
        } as never)
      expect(await client.getWireClaimable("wirercpt")).toBe(0n)
    })

    it("returns 0n when the table has no rows at all", async () => {
      const client = new WireClient(config)
      jest
        .spyOn(client, "getTableRows")
        .mockResolvedValue({ rows: [], more: false } as never)
      expect(await client.getWireClaimable("wirercpt")).toBe(0n)
    })

    it("reads payclaims through its own key + row field names", async () => {
      const client = new WireClient(config),
        captured: any[] = []
      jest.spyOn(client, "getTableRows").mockImplementation(async (query: any) => {
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
      const { account } = JSON.parse(WireClient.nameKeyBound("account", "wirercpt"))
      expect(typeof account).toBe("string")
      expect(account).toMatch(/^[0-9]+$/)
      expect(BigInt(account)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    })

    it("honours the per-table key field name", () => {
      // wireclaims keys on `account`; payclaims keys on `account_name`. One helper, two shapes.
      expect(Object.keys(JSON.parse(WireClient.nameKeyBound("account_name", "wirercpt")))).toEqual([
        "account_name"
      ])
    })

    it("round-trips distinct accounts to distinct bounds", () => {
      expect(WireClient.nameKeyBound("account", "wirercpt")).not.toBe(
        WireClient.nameKeyBound("account", "wireno.aaa")
      )
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
})
