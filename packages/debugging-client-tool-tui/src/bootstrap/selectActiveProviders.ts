import type { FeatureProvider } from "../features/FeatureProvider.js"
import { getGlobalLogger } from "../logging/LoggingManager.js"

/**
 * Compute the active provider subset per `--features`.
 *
 * Rules:
 *   - `filter === null` → all providers are active (no flag passed).
 *   - Required providers (`isRequiredProvider: true`) are always included
 *     regardless of the filter.
 *   - All other providers are included iff their lowercased `id` is in `filter`.
 *
 * @param all every known provider
 * @param filter lowercase id set, or null when `--features` was omitted
 * @return providers that should be registered this run
 */
export function selectActiveProviders(
  all: readonly FeatureProvider[],
  filter: Set<string> | null
): FeatureProvider[] {
  return all.filter(
    p =>
      p.isRequiredProvider ||
      filter === null ||
      filter.has(p.id.toLowerCase())
  )
}

/**
 * Warn (via the global TUI logger) about any `--features` id that doesn't match
 * a known provider. Silent when all ids resolved.
 *
 * @param filter raw lowercase id set from the CLI
 * @param activeIds ids of providers actually activated
 */
export function warnUnknownFeatureIds(
  filter: Set<string>,
  activeIds: readonly string[]
): void {
  const log = getGlobalLogger(),
    known = new Set(activeIds.map(id => id.toLowerCase()))
  ;[...filter]
    .filter(id => !known.has(id))
    .forEach(id => log.warn(`--features: unknown feature id "${id}"`))
}
