import type { APIClient } from "@wireio/sdk-core"

import { apiChainEnvelopeReader } from "@wireio/opp-stress-harness"

/** The `get_table_rows` arguments each stubbed call records. */
interface TableRowsCall {
  code: string
  scope: string
  table: string
}

/** A minimal APIClient stub recording its `get_table_rows` calls. */
function stubApi(
  rowsByTable: Readonly<Record<string, readonly unknown[]>>,
  calls: TableRowsCall[]
): APIClient {
  return {
    v1: {
      chain: {
        get_table_rows: async (opts: TableRowsCall) => {
          calls.push({ code: opts.code, scope: opts.scope, table: opts.table })
          return { rows: rowsByTable[opts.table] ?? [] }
        }
      }
    }
  } as unknown as APIClient
}

describe("apiChainEnvelopeReader", () => {
  it("reads and KV-unwraps outbound envelopes", async () => {
    // Given: a KV-wrapped outenvelopes row as v6 depot tables return it.
    const calls: TableRowsCall[] = [],
      reader = apiChainEnvelopeReader(
        stubApi(
          {
            outenvelopes: [
              { key: { id: 1 }, value: { id: 1, chain_code: 111, epoch_index: 7 } }
            ]
          },
          calls
        )
      )

    // When: the reader fetches outbound envelopes.
    const rows = await reader.readOutboundEnvelopes()

    // Then: it queries sysio.msgch and returns the flat, unwrapped row.
    expect(calls).toContainEqual({
      code: "sysio.msgch",
      scope: "sysio.msgch",
      table: "outenvelopes"
    })
    expect(rows).toEqual([{ id: 1, chain_code: 111, epoch_index: 7 }])
  })

  it("reads the chain registry from sysio.chains", async () => {
    // Given: a chains row (already flat / multi_index shape).
    const calls: TableRowsCall[] = [],
      reader = apiChainEnvelopeReader(
        stubApi({ chains: [{ code: { value: 111 }, kind: 2 }] }, calls)
      )

    // When/Then: the reader queries sysio.chains and passes rows through.
    const rows = await reader.readChains()
    expect(calls).toContainEqual({
      code: "sysio.chains",
      scope: "sysio.chains",
      table: "chains"
    })
    expect(rows).toEqual([{ code: { value: 111 }, kind: 2 }])
  })
})
