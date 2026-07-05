import Os from "node:os"
import Path from "node:path"
import { SysioContracts } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool/Constants"
import { BindConfig } from "@wireio/cluster-tool/config"
import {
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
      nodeopUrl: toURL(await BindConfig.findAvailable(BindConfig.DefaultBiosHttp)),
      kiodUrl: null
    }
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
        .actions.init.prepare({ version: 0, core: Constants.CORE_SYMBOL_SPECIFICATION })
      expect(payload.account).toBe("sysio")
    })
  })

  describe("getTransactionId", () => {
    it("extracts from an object", () => {
      expect(WireClient.getTransactionId({ transaction_id: "abc" })).toBe("abc")
    })
    it("extracts from a JSON string", () => {
      expect(WireClient.getTransactionId('{"transaction_id":"def"}')).toBe("def")
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
