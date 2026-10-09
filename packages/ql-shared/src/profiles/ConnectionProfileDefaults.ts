import { uniq } from "lodash"

import { SysioContracts } from "@wireio/sdk-core"

/** Profile defaults — declared before any schema reads them. */
export namespace ConnectionProfileDefaults {
  /**
   * Client fetch ceiling (ms). Must exceed the server deadline plus the transfer
   * of an 8 MiB body, so a healthy server is never abandoned early.
   */
  export const TransportTimeoutMs = 10_000
  /** Auto-retry attempts after the first (only for server-retryable kinds). */
  export const Retries = 2

  /**
   * Owner seed when a profile stores none — every system-contract account,
   * resolved at READ time so new system contracts appear automatically.
   *
   * @returns The distinct system-contract owner accounts.
   */
  export function owners(): string[] {
    return uniq(Object.values(SysioContracts.SysioContractAccount))
  }
}
