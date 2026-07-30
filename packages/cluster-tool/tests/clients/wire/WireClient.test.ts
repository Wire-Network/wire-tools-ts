import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import { Constants } from "@wireio/cluster-tool/Constants"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import {
  WireClient,
  type WireClientConfig
} from "@wireio/cluster-tool/clients/wire"
import { ClioRunner } from "@wireio/cluster-tool/clients/wire/clio/ClioRunner"
import { toURL } from "@wireio/cluster-tool/utils"
import { SysioContracts } from "@wireio/sdk-core"

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

  describe("getSysioContract proxy", () => {
    const epochClient = () =>
      new WireClient(config).getSysioContract(
        SysioContracts.SysioContractName.epoch
      )

    it("resolves a known action to an invoker", () => {
      const epoch = epochClient()
      expect(typeof epoch.actions.advance.prepare).toBe("function")
      expect(typeof epoch.actions.advance.invoke).toBe("function")
      expect(typeof epoch.actions.advance.invokeOnce).toBe("function")
      expect(typeof epoch.actions.advance.invokeViaFile).toBe("function")
      expect(typeof epoch.actions.advance.invokeViaFileOnce).toBe("function")
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

  describe("single-attempt action invocation", () => {
    it("does not resend after a finality observation failure", async () => {
      const runOnce = jest
          .spyOn(ClioRunner.prototype, "runOnce")
          .mockResolvedValue({ transaction_id: "abc" } as never),
        wait = jest
          .spyOn(WireClient.prototype, "waitForTransactionInBlock")
          .mockRejectedValue(new Error("observation lost"))
      try {
        await expect(
          new WireClient(config)
            .getSysioContract(SysioContracts.SysioContractName.epoch)
            .actions.advance.invokeOnce({})
        ).rejects.toMatchObject({
          name: "TransactionFinalityError",
          transactionId: "abc",
          observedBlockNum: null
        })
        expect(runOnce).toHaveBeenCalledTimes(1)
      } finally {
        runOnce.mockRestore()
        wait.mockRestore()
      }
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

  describe("getTableRows", () => {
    it("preserves the chain pagination key in the typed result", async () => {
      const client = new WireClient(config),
        getTableRows = jest
          .spyOn(client.api.v1.chain, "get_table_rows")
          .mockResolvedValue({
            rows: [{ value: { id: "17" } }],
            more: true,
            next_key: "18"
          } as never)
      try {
        await expect(
          client.getTableRows({
            account: "sysio.dclaim",
            scope: "sysio.dclaim",
            table: "unmapped"
          })
        ).resolves.toEqual({
          rows: [{ id: "17" }],
          more: true,
          nextKey: "18"
        })
      } finally {
        getTableRows.mockRestore()
      }
    })
  })

  describe("isTransactionIrreversible", () => {
    const irreversibleBlock: WireClient.GetBlockResponse = {
      block_num: 17,
      id: "block-id",
      transactions: [{ status: "executed", trx: { id: "tx1" } }]
    }

    it("accepts a transaction present in a block at or below LIB", async () => {
      const client = new WireClient(config)
      jest.spyOn(client, "getTransaction").mockResolvedValue({
        id: "tx1",
        block_num: 17,
        block_time: "1970-01-01T00:00:00.000"
      })
      jest.spyOn(client, "getInfo").mockResolvedValue({
        head_block_num: 20,
        last_irreversible_block_num: 18
      } as WireClient.GetInfoResponse)
      jest.spyOn(client, "getBlock").mockResolvedValue(irreversibleBlock)

      await expect(client.isTransactionIrreversible("tx1")).resolves.toBe(true)
    })

    it("rejects a transaction observed only above LIB", async () => {
      const client = new WireClient(config)
      jest.spyOn(client, "getTransaction").mockResolvedValue({
        id: "tx1",
        block_num: 19,
        block_time: "1970-01-01T00:00:00.000"
      })
      jest.spyOn(client, "getInfo").mockResolvedValue({
        head_block_num: 20,
        last_irreversible_block_num: 18
      } as WireClient.GetInfoResponse)
      const getBlock = jest
        .spyOn(client, "getBlock")
        .mockResolvedValue(irreversibleBlock)

      await expect(client.isTransactionIrreversible("tx1", 19)).resolves.toBe(
        false
      )
      expect(getBlock).not.toHaveBeenCalled()
    })
  })

  describe("invokeViaFile", () => {
    it("isolates concurrent payload files and removes them after use", async () => {
      const paths: string[] = []
      const contents: string[] = []
      let releaseBoth: () => void = () => {}
      const bothStarted = new Promise<void>(resolve => {
        releaseBoth = resolve
      })
      const run = jest
        .spyOn(ClioRunner.prototype, "run")
        .mockImplementation(async args => {
          const file = args.at(-1)!
          paths.push(file)
          if (paths.length === 2) releaseBoth()
          await bothStarted
          contents.push(Fs.readFileSync(file, "utf8"))
          return { transaction_id: "" } as never
        })
      try {
        const client = new WireClient(config)
        await Promise.all([
          client.invokeViaFile(
            "sysio.dclaim",
            "importseed",
            { marker: "first" },
            [{ actor: "sysio.dclaim", permission: "active" }],
            { skipWait: true }
          ),
          client.invokeViaFile(
            "sysio.dclaim",
            "importseed",
            { marker: "second" },
            [{ actor: "sysio.dclaim", permission: "active" }],
            { skipWait: true }
          )
        ])

        expect(new Set(paths).size).toBe(2)
        expect(contents.map(content => JSON.parse(content))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              actions: [expect.objectContaining({ data: { marker: "first" } })]
            }),
            expect.objectContaining({
              actions: [expect.objectContaining({ data: { marker: "second" } })]
            })
          ])
        )
        paths.forEach(file => {
          expect(Fs.existsSync(file)).toBe(false)
          expect(Fs.existsSync(Path.dirname(file))).toBe(false)
        })
      } finally {
        run.mockRestore()
      }
    })

    it("uses the one-attempt transport and removes its payload file", async () => {
      let payloadFile = ""
      const runOnce = jest
        .spyOn(ClioRunner.prototype, "runOnce")
        .mockImplementation(async args => {
          payloadFile = args.at(-1)!
          expect(
            JSON.parse(Fs.readFileSync(payloadFile, "utf8"))
          ).toMatchObject({
            actions: [expect.objectContaining({ data: { marker: "once" } })]
          })
          return { transaction_id: "" } as never
        })
      try {
        await new WireClient(config).invokeViaFileOnce(
          "sysio.dclaim",
          "importseed",
          { marker: "once" },
          [{ actor: "sysio.dclaim", permission: "active" }],
          { skipWait: true }
        )
        expect(runOnce).toHaveBeenCalledTimes(1)
        expect(Fs.existsSync(payloadFile)).toBe(false)
        expect(Fs.existsSync(Path.dirname(payloadFile))).toBe(false)
      } finally {
        runOnce.mockRestore()
      }
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
