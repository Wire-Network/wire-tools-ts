import type { QueryHistoryEntry } from "@wireio/ql-shared"
import type { QueryHistoryStore } from "@wireio/ql-shared/node"
import { getLogger, NestedError } from "@wireio/shared"

const log = getLogger(__filename)

/**
 * Append a history record best-effort: a failed append (read-only state
 * directory, full disk) is logged and never fails the query that produced it.
 * The ONE recorder of `wql` runs and TUI runs.
 *
 * @param store - The shared `history.jsonl`.
 * @param entry - The record.
 * @returns Whether the record was appended.
 */
export function recordHistory(store: QueryHistoryStore, entry: QueryHistoryEntry): boolean {
  try {
    store.append(entry)
    return true
  } catch (error) {
    log.warn(`history append failed: ${NestedError.toError(error).message}`)
    return false
  }
}
