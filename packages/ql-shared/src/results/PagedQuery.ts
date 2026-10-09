import type { ExecuteOptions, QueryEngineClient, QueryExecution } from "../client/index.js"
import type { QueryPager } from "./QueryPager.js"

/** Fetches pages of one query through a client (shared by CLI, TUI and the GUI query host). */
export class PagedQuery {
  /**
   * @param client - The engine client.
   * @param query - The SQL text.
   */
  constructor(
    readonly client: QueryEngineClient,
    readonly query: string
  ) {}

  /**
   * Execute the pager's window; the result carries `result.page`.
   *
   * @param pager - Which page.
   * @param options - Deadline / cancellation (its limit/offset are replaced by the window).
   * @returns The execution.
   */
  fetch(pager: QueryPager, options: ExecuteOptions = {}): Promise<QueryExecution> {
    const { limit, offset } = pager.window
    return this.client.execute(this.query, { ...options, limit, offset })
  }
}
