import type { APIClient } from "@wireio/sdk-core"

/** The ABI the fake chain API serves: one table `positions` (key `id`, value `name`, `amount`). */
export const SampleAbi = {
  version: "sysio::abi/1.2",
  types: [],
  structs: [{ name: "position", base: "", fields: [{ name: "name", type: "string" }, { name: "amount", type: "uint64" }] }],
  actions: [],
  tables: [{ name: "positions", type: "position", index_type: "i64", key_names: ["id"], key_types: ["uint64"] }],
  ricardian_clauses: [],
  error_messages: [],
  abi_extensions: [],
  variants: []
}

/** A get_abi call the fake received. */
export interface FakeChainAPI {
  /** The client to inject (`SchemaCatalogOptions.chainAPI`). */
  client: APIClient
  /** Owners requested, in order. */
  requested: string[]
}

/**
 * A chain API whose `get_abi` serves {@link SampleAbi} (an owner named `missing` fails).
 *
 * @returns The fake.
 */
export function createFakeChainAPI(): FakeChainAPI {
  const requested: string[] = [],
    client = {
      v1: {
        chain: {
          get_abi: async (owner: string) => {
            requested.push(owner)
            if (owner === "missing") throw new Error(`unknown account ${owner}`)
            return { account_name: owner, abi: SampleAbi }
          }
        }
      }
    }
  return { client: client as unknown as APIClient, requested }
}
