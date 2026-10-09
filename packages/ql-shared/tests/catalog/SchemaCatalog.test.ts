import { identity } from "lodash"

import {
  CatalogFieldRole,
  createSchemaCatalogDefaultOptions,
  LogicalType,
  QueryEngineClient,
  QueryFailure,
  SchemaCatalog,
  type SchemaCatalogOptions
} from "@wireio/ql-shared"

import { createProfile } from "../common/profileFixtures.js"
import { column } from "../common/resultFixtures.js"

// sdk-core types are taken from the API under test: sdk-core is a hybrid
// package, so naming its types here would resolve its CJS declarations while
// the source resolves its ESM ones.
/** The chain API client type SchemaCatalog accepts. */
type ChainAPI = SchemaCatalogOptions["chainAPI"]
/** The ABI definition type SchemaCatalog reads. */
type AbiDefinition = Parameters<typeof SchemaCatalog.tablesOf>[0]

const abi = {
  version: "sysio::abi/1.2",
  types: [{ new_type_name: "operator_alias", type: "operator_row" }],
  structs: [
    { name: "base_row", base: "", fields: [{ name: "created", type: "time_point" }] },
    { name: "operator_row", base: "base_row", fields: [{ name: "status", type: "uint8" }, { name: "stake", type: "asset" }] }
  ],
  tables: [{ name: "operators", index_type: "kv", key_names: ["account"], key_types: ["name"], type: "operator_alias" }],
  actions: [],
  variants: [],
  ricardian_clauses: [],
  action_results: [],
  enums: []
} as unknown as AbiDefinition

/** A chain API stub answering get_abi. */
function chainAPI(getAbi: jest.Mock): ChainAPI {
  return { v1: { chain: { get_abi: getAbi } } } as unknown as ChainAPI
}

const profile = createProfile({ owners: ["sysio.opreg"] })

describe("SchemaCatalog", () => {
  it("loads tables with key fields from the ABI and value fields from the (typedef'd, based) row struct", async () => {
    const getAbi = jest.fn().mockResolvedValue({ account_name: "sysio.opreg", abi }),
      catalog = new SchemaCatalog(profile, new QueryEngineClient(profile), { chainAPI: chainAPI(getAbi) }),
      snapshot = await catalog.loadOwner("sysio.opreg")
    expect(getAbi).toHaveBeenCalledWith("sysio.opreg")
    expect(snapshot.owners[0]).toMatchObject({ account: "sysio.opreg", loaded: true })
    expect(snapshot.owners[0].tables[0].fields).toEqual([
      { path: "key.account", role: CatalogFieldRole.key, abiType: "name", logicalType: null },
      { path: "created", role: CatalogFieldRole.value, abiType: "time_point", logicalType: null },
      { path: "status", role: CatalogFieldRole.value, abiType: "uint8", logicalType: null },
      { path: "stake", role: CatalogFieldRole.value, abiType: "asset", logicalType: null }
    ])
    expect(catalog.snapshot).toBe(snapshot)
  })

  it("describe fills VALUE logical types via the LIMIT 0 probe (loading the owner first)", async () => {
    const getAbi = jest.fn().mockResolvedValue({ account_name: "sysio.opreg", abi }),
      queryClient = new QueryEngineClient(profile),
      describe = jest.spyOn(queryClient, "describe").mockResolvedValue([
        column("status", LogicalType.enumeration),
        column("stake", LogicalType.asset)
      ]),
      catalog = new SchemaCatalog(profile, queryClient, { chainAPI: chainAPI(getAbi) }),
      table = (await catalog.describe("sysio.opreg", "operators")).owners[0].tables[0]
    expect(describe).toHaveBeenCalledWith("sysio.opreg", "operators", {})
    expect(table.described).toBe(true)
    expect(table.fields.map(field => field.logicalType)).toEqual([null, null, LogicalType.enumeration, LogicalType.asset])
  })

  it("adds an unknown owner, handles an account without ABI and invalidates", async () => {
    const getAbi = jest.fn().mockResolvedValue({ account_name: "plain" }),
      catalog = new SchemaCatalog(profile, new QueryEngineClient(profile), { chainAPI: chainAPI(getAbi) }),
      loaded = await catalog.loadOwner("plain")
    expect(loaded.owners.map(owner => owner.account)).toEqual(["sysio.opreg", "plain"])
    expect(loaded.owners[1]).toEqual({ account: "plain", tables: [], loaded: true })
    expect(catalog.invalidate("plain").owners[1].loaded).toBe(false)
    expect(catalog.invalidate().owners.every(owner => !owner.loaded)).toBe(true)
  })

  it("wraps a get_abi failure with its cause", async () => {
    const failure = new Error("unknown account"),
      catalog = new SchemaCatalog(profile, new QueryEngineClient(profile), { chainAPI: chainAPI(jest.fn().mockRejectedValue(failure)) })
    await expect(catalog.loadOwner("nobody")).rejects.toMatchObject({ cause: failure })
  })

  it("an aborted signal rejects loadOwner with the abort reason (a cancelled failure) and leaves the snapshot alone", async () => {
    const getAbi = jest.fn().mockReturnValue(new Promise(() => undefined)),
      catalog = new SchemaCatalog(profile, new QueryEngineClient(profile), { chainAPI: chainAPI(getAbi) }),
      before = catalog.snapshot,
      controller = new AbortController(),
      loading = catalog.loadOwner("sysio.opreg", { signal: controller.signal })
    controller.abort()
    const error = await loading.then(() => null, identity<Error>)
    expect(error.name).toBe(QueryFailure.AbortErrorName)
    expect(QueryFailure.of(error)).toEqual(QueryEngineClient.cancelledFailure())
    expect(catalog.snapshot).toBe(before)
  })

  it("describe forwards its options (the signal) to the owner load", async () => {
    const getAbi = jest.fn(),
      catalog = new SchemaCatalog(profile, new QueryEngineClient(profile), { chainAPI: chainAPI(getAbi) }),
      controller = new AbortController()
    controller.abort()
    await expect(catalog.describe("sysio.opreg", "operators", { signal: controller.signal })).rejects.toMatchObject({ name: QueryFailure.AbortErrorName })
    expect(getAbi).toHaveBeenCalledWith("sysio.opreg")
  })

  it("untilAborted passes the work through, rejects on abort and removes its listener", async () => {
    await expect(SchemaCatalog.untilAborted(Promise.resolve(1), undefined)).resolves.toBe(1)
    const settled = new AbortController(),
      removed = jest.spyOn(settled.signal, "removeEventListener")
    await expect(SchemaCatalog.untilAborted(Promise.resolve(2), settled.signal)).resolves.toBe(2)
    expect(removed).toHaveBeenCalledWith(SchemaCatalog.AbortEvent, expect.any(Function))
    const already = new AbortController()
    already.abort(new Error("gone"))
    await expect(SchemaCatalog.untilAborted(Promise.resolve(3), already.signal)).rejects.toThrow("gone")
    const later = new AbortController(),
      racing = SchemaCatalog.untilAborted(new Promise(() => undefined), later.signal)
    later.abort(new Error("stopped"))
    await expect(racing).rejects.toThrow("stopped")
  })

  it("defaults the chain API to the profile endpoint and the owners to the profile", () => {
    const catalog = new SchemaCatalog(profile, new QueryEngineClient(profile))
    expect(catalog.config.chainAPI).toBeDefined()
    expect(catalog.snapshot.owners.map(owner => owner.account)).toEqual(["sysio.opreg"])
  })

  it("never builds a default chain API when one is injected", () => {
    const injected = chainAPI(jest.fn()),
      catalog = new SchemaCatalog(profile, new QueryEngineClient(profile), { chainAPI: injected })
    expect(catalog.config.chainAPI).toBe(injected)
    expect(createSchemaCatalogDefaultOptions(profile).chainAPI).not.toBe(injected)
    expect(new SchemaCatalog(profile, new QueryEngineClient(profile), { chainAPI: undefined }).config.chainAPI).toBeDefined()
  })

  it("derives struct fields only for structs", () => {
    expect(SchemaCatalog.structFields(abi, "missing")).toEqual([])
    expect(SchemaCatalog.tablesOf({ ...abi, tables: [] })).toEqual([])
  })
})
