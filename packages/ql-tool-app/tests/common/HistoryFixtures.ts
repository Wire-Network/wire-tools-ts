import { QueryOutcome, type QueryHistoryEntry } from "@wireio/ql-shared"

/** Query-history entries for the store, handler and panel suites. */
export namespace HistoryFixtures {
  /** The profile every fixture entry ran against. */
  export const ProfileName = "local"
  /** When every fixture entry ran. */
  export const ExecutedAt = "2026-10-07T12:00:00.000Z"

  /**
   * A successful one-row history entry.
   *
   * @param id - Entry id.
   * @param query - The SQL it ran.
   * @returns The entry.
   */
  export function entry(id: string, query: string): QueryHistoryEntry {
    return {
      id,
      profile: ProfileName,
      query,
      executedAt: ExecutedAt,
      outcome: QueryOutcome.success,
      errorKind: null,
      returnedRows: 1,
      wallTimeMs: 1
    }
  }
}
