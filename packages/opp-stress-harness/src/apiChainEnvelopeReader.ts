import { APIClient, SystemContracts } from "@wireio/sdk-core"

import type { ChainEnvelopeReader } from "./chainEnvelopeSource.js"

/** Depot account holding the outbound-envelope and chain-registry tables. */
const MsgchAccount = "sysio.msgch",
  /** Chain-registry contract account. */
  ChainsAccount = "sysio.chains",
  /** Outbound depot→outpost envelope table. */
  OutEnvelopesTable = "outenvelopes",
  /** Chain registry table. */
  ChainsTable = "chains",
  /** Row cap per read; the depot's outbound table is one-deep per outpost. */
  DefaultRowLimit = 1_000

/**
 * A `ChainEnvelopeReader` over an ordinary sdk-core `APIClient`.
 *
 * Reads the depot's `outenvelopes` and `chains` tables via un-privileged
 * `get_table_rows` — the exact calls any testnet observer can make. Construct
 * the client from a node's HTTP URL (`new APIClient({ url })`); no keys, no
 * cluster, no filesystem.
 *
 * @param api sdk-core API client pointed at a WIRE depot HTTP endpoint.
 * @returns A reader suitable for `chainEnvelopeSource`.
 */
export function apiChainEnvelopeReader(api: APIClient): ChainEnvelopeReader {
  return {
    readOutboundEnvelopes: () =>
      readTable<SystemContracts.SysioMsgchOutboundEnvelopeType>(
        api,
        MsgchAccount,
        OutEnvelopesTable
      ),
    readChains: () =>
      readTable<SystemContracts.SysioChainsChainRowType>(
        api,
        ChainsAccount,
        ChainsTable
      )
  }
}

/**
 * Read one contract-global table as JSON rows, unwrapping KV `{key,value}` rows.
 *
 * The generated row types (`T`) describe the flat row shape, so the KV wrapper
 * v6 depot tables return is normalized away at this boundary.
 */
async function readTable<T>(
  api: APIClient,
  account: string,
  table: string
): Promise<readonly T[]> {
  // get_table_rows' parameter/return types at the sdk-core boundary are looser
  // than the generated row shape; normalize to `T` immediately after unwrap.
  const result = await api.v1.chain.get_table_rows({
    code: account,
    scope: account,
    table,
    limit: DefaultRowLimit,
    json: true
  } as Parameters<APIClient["v1"]["chain"]["get_table_rows"]>[0])
  const { rows } = result as TableRowsEnvelope,
    tableRows: readonly unknown[] = rows ?? []
  return tableRows.map(unwrapKvRow) as readonly T[]
}

/** The `get_table_rows` response leg this reader consumes. */
interface TableRowsEnvelope {
  rows?: readonly unknown[]
}

/** A v6 KV table row wrapper, whose flat row rides `value`. */
interface KvRowWrapper {
  value: unknown
}

/** Unwrap a v6 KV `{ key, value }` row to its flat `value`; pass others through. */
function unwrapKvRow(row: unknown): unknown {
  return row !== null && typeof row === "object" && "value" in row
    ? (row as KvRowWrapper).value
    : row
}
