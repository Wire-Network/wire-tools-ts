import { SlugName, SysioContracts } from "@wireio/sdk-core"

/** Maximum rows accepted by one readiness table scan. */
export const ReadinessMaxTableRows = 1_000

interface SlugValue {
  value: number | string
}

interface BoundedQueryResult {
  more: boolean
}

/** Display an endpoint without credentials, query parameters, or fragments. */
export function readinessEndpointLabel(value: string): string {
  const url = new URL(value)
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "")
}

/** ABI/protobuf enum compatibility check for numeric or named values. */
export function readinessEnumMatches(
  value: unknown,
  numeric: number,
  name: string
): boolean {
  return (
    value === numeric || value === name || String(value) === String(numeric)
  )
}

/** Numeric value of a generated slug cell. */
export function readinessSlugValue(value: SlugValue): number {
  return Number(value.value)
}

/** Human-readable value of a generated slug cell. */
export function readinessSlug(value: SlugValue): string {
  return SlugName.toString(readinessSlugValue(value))
}

/** Human-readable chain/token/reserve triple for diagnostics. */
export function readinessReserveLabel(
  reserve: SysioContracts.SysioReservReserveRowType
): string {
  return `${readinessSlug(reserve.chain_code)}/${readinessSlug(reserve.token_code)}/${readinessSlug(reserve.reserve_code)}`
}

/** Reject a truncated bounded table scan. */
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
