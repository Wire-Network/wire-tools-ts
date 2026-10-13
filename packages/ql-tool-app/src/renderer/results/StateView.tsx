import type { QueryExecutionSuccess } from "@wireio/ql-shared"

import { KeyValueTable } from "./KeyValueTable.js"

/** Props of {@link StateView}. */
export interface StateViewProps {
  /** The successful execution. */
  execution: QueryExecutionSuccess
}

/**
 * The block snapshot the page reflects (chain, block, LIB, read mode, ABIs, synced).
 *
 * @param props - The execution.
 * @returns The table.
 */
export function StateView({ execution }: StateViewProps) {
  const { state, source } = execution.result
  return (
    <KeyValueTable
      testId="state-view"
      entries={[
        { label: "chain_id", value: state.chain_id },
        { label: "block_num", value: state.block_num },
        { label: "block_id", value: state.block_id },
        { label: "block_time", value: state.block_time },
        { label: "last_irreversible_block_num", value: state.last_irreversible_block_num },
        { label: "read_mode", value: state.read_mode },
        { label: "synced", value: String(state.synced) },
        { label: "captured_at", value: state.captured_at },
        { label: "source", value: `${source.owners.join(", ")} · ${source.table}` },
        ...state.abis.map(abi => ({ label: `abi ${abi.owner}`, value: abi.hash }))
      ]}
    />
  )
}
