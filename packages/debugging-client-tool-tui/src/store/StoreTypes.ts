/**
 * Leaf-module constants consumed by every slice, selector, and the root
 * `Store.ts`. Importing from here (rather than `Store.ts`) prevents circular
 * dependencies — slices define their own names and `Store.ts` only imports
 * reducers.
 */

/** Stable identifiers for every Redux slice. Used in reducer keys and selectors. */
export enum SliceName {
  UI = "ui",
  Cluster = "cluster",
  Features = "features",
  OPP = "opp",
  ProcessMonitor = "processMonitor"
}

/** Status-string default for a fresh session. */
export const DefaultStatus = "idle" as const
