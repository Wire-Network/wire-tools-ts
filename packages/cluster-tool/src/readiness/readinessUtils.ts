import { SlugName } from "@wireio/sdk-core"

/** Maximum rows accepted by one readiness table scan. */
export const ReadinessMaxTableRows = 1_000

interface SlugValue {
  value: number | string
}

interface BoundedQueryResult {
  more: boolean
}

/** ABI/protobuf enum compatibility check for generated numeric or named values. */
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
