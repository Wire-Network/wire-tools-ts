import { CollateralTools } from "./UnderwriterTools.js"

export { CollateralTools } from "./UnderwriterTools.js"

/**
 * Public-facing barrel for the underwriter tool cohort. Consumers
 * call into `UnderwriterTools.Collateral.<name>` rather than
 * importing free functions, so the surface is namespaced and
 * extensible — a future race-instrumentation cohort slots in as
 * `UnderwriterTools.Race = RaceTools` without churning every call
 * site.
 *
 * `export import Collateral = CollateralTools` re-exports BOTH the
 * value space (the const members) AND the type space (interfaces
 * like `DepositContext` / `DepositOptions`) of the source namespace.
 * `export const Collateral = CollateralTools` would only bring the
 * value space, and consumers writing
 * `UnderwriterTools.Collateral.DepositContext[]` would fail with
 * "Namespace has no exported member 'Collateral'" at the type
 * position.
 */
export namespace UnderwriterTools {
  /** Underwriter-collateral helpers — defaults, JSON parsing, deposit. */
  export import Collateral = CollateralTools
}
