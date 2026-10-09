import { JsonRPCProtocol } from "@wireio/cluster-tool-shared"
import { CatalogFieldRole, CatalogSnapshot, LogicalType, ValueEncoding } from "@wireio/ql-shared"

import { QLExitCode, QLUsageError, SchemaCommand } from "@wireio/ql-tool-cli/cli/index.js"

import { createFakeChainAPI } from "../../common/fakeChainAPI.js"
import { runWql } from "../../common/runWql.js"
import { useStubEngine } from "../../common/stubEngine.js"
import { createResult } from "../../common/engineFixtures.js"
import { createTestContext } from "../../common/testContext.js"

describe("wql schema", () => {

  const engine = useStubEngine(() => ({
      jsonrpc: JsonRPCProtocol.Version,
      result: createResult(
        [
          { name: "name", logical_type: LogicalType.text, abi_type: "string", nullable: false, encoding: ValueEncoding.text },
          { name: "amount", logical_type: LogicalType.integer, abi_type: "uint64", nullable: false, encoding: ValueEncoding.decimal_string }
        ],
        []
      )
    }))

  /** A context with the fake chain API. */
  function context() {
    const chain = createFakeChainAPI()
    return { chain, ...createTestContext({ catalogOptions: { chainAPI: chain.client } }) }
  }

  it("owners lists the profile's owners (custom or the system-contract default)", async () => {
    const custom = await runWql(["schema", "owners", "-u", engine().endpoint, "--owners", "a", "--owners", "b"], context().context)
    expect(custom.stdout).toEqual(["a", "b"])
    const seeded = await runWql(["schema", "owners", "-u", engine().endpoint], context().context)
    expect(seeded.stdout).toEqual(expect.arrayContaining(["sysio"]))
  })

  it("tables lists an owner's ABI tables", async () => {
    const { context: wql, chain } = context(),
      run = await runWql(["schema", "tables", "sample", "-u", engine().endpoint], wql)
    expect(run.stdout).toEqual(["positions\tposition"])
    expect(chain.requested).toEqual(["sample"])
  })

  it("fields lists key and value fields; describe fills logical types via LIMIT 0", async () => {
    const fields = await runWql(["schema", "fields", "sample", "positions", "-u", engine().endpoint], context().context)
    expect(fields.stdout).toEqual(["key.id\tkey\tuint64\t-", "name\tvalue\tstring\t-", "amount\tvalue\tuint64\t-"])
    const described = await runWql(["schema", "describe", "sample", "positions", "-u", engine().endpoint], context().context)
    expect(described.stdout).toEqual(["key.id\tkey\tuint64\t-", "name\tvalue\tstring\ttext", "amount\tvalue\tuint64\tinteger"])
    expect(engine().requests.at(-1).params).toMatchObject({ limit: 0 })
  })

  it("an unknown table is a usage error; a failing get_abi fails; a missing subcommand is usage", async () => {
    const unknown = await runWql(["schema", "fields", "sample", "nope", "-u", engine().endpoint], context().context)
    expect(unknown.exitCode).toBe(QLExitCode.usage)
    expect(unknown.stderr[0]).toMatch(/table sample\.nope is not in the catalog.*; list them with/)
    expect((await runWql(["schema", "tables", "missing", "-u", engine().endpoint], context().context)).exitCode).toBe(QLExitCode.failure)
    expect((await runWql(["schema"], context().context)).exitCode).toBe(QLExitCode.usage)
  })

  it("assertInCatalog maps a lookup miss to a usage error and passes a hit through", () => {
    expect(SchemaCommand.assertInCatalog(() => 7)).toBe(7)
    expect(() =>
      SchemaCommand.assertInCatalog(() => CatalogSnapshot.findOwner({ endpoint: "e", capturedAt: "", owners: [] }, "nobody"))
    ).toThrow(QLUsageError)
  })

  it("formats table and field lines", () => {
    expect(SchemaCommand.tableLine({ name: "t", rowType: "r", fields: [], described: false })).toBe("t\tr")
    expect(SchemaCommand.fieldLine({ path: "x", role: CatalogFieldRole.value, abiType: "string", logicalType: LogicalType.text })).toBe("x\tvalue\tstring\ttext")
  })
})
