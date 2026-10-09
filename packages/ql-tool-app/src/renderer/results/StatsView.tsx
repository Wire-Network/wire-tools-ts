import type { QueryExecutionSuccess } from "@wireio/ql-shared"

import { KeyValueTable } from "./KeyValueTable.js"

/** Props of {@link StatsView}. */
export interface StatsViewProps {
  /** The successful execution. */
  execution: QueryExecutionSuccess
}

/**
 * Engine work counters + page window + client wall time and attempts.
 *
 * @param props - The execution.
 * @returns The table.
 */
export function StatsView({ execution }: StatsViewProps) {
  const { stats, page } = execution.result
  return (
    <KeyValueTable
      testId="stats-view"
      entries={[
        ...Object.entries(stats).map(([label, value]) => ({ label, value })),
        ...Object.entries(page).map(([label, value]) => ({ label: `page.${label}`, value: String(value) })),
        { label: "client wall time (ms)", value: execution.wallTimeMs.toFixed(1) },
        { label: "attempts", value: String(execution.attempts) },
        { label: "request id", value: execution.requestId }
      ]}
    />
  )
}
