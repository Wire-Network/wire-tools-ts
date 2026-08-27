import { SlugName, SysioContracts } from "@wireio/sdk-core"

import { slugValue } from "./slugUtils.js"

/** Maximum rows accepted by one readiness table scan before the proof fails as incomplete. */
export const ReadinessMaxTableRows = 1_000

interface ReadinessSlugValue {
  value: number | string
}

interface BoundedQueryResult {
  more: boolean
}

/**
 * Display an endpoint without credentials, query parameters, or fragments.
 *
 * @param value - Endpoint URL to redact for report evidence.
 * @returns A credential-free protocol, host, and path label.
 */
export function readinessEndpointLabel(value: string): string {
  const url = new URL(value)
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "")
}

/**
 * Convert a generated slug cell to its human-readable name.
 *
 * @param value - Generated slug cell returned by a WIRE table query.
 * @returns The decoded slug name.
 */
export function readinessSlug(value: ReadinessSlugValue): string {
  return SlugName.toString(slugValue(value))
}

/**
 * Format a reserve row as a human-readable chain/token/reserve triple.
 *
 * @param reserve - Generated reserve table row.
 * @returns The reserve diagnostic label.
 */
export function readinessReserveLabel(
  reserve: SysioContracts.SysioReservReserveRowType
): string {
  return `${readinessSlug(reserve.chain_code)}/${readinessSlug(reserve.token_code)}/${readinessSlug(reserve.reserve_code)}`
}

/**
 * Reject a table result that would make the bounded readiness proof incomplete.
 *
 * @param operation - Pending typed table query.
 * @param label - Table label used in diagnostics.
 * @returns The complete query result.
 */
export async function readinessBoundedQuery<T extends BoundedQueryResult>(
  operation: Promise<T>,
  label: string
): Promise<T> {
  const result = await operation
  if (result.more) {
    throw new Error(
      `${label} exceeds the ${ReadinessMaxTableRows}-row readiness scan limit`
    )
  }
  return result
}
