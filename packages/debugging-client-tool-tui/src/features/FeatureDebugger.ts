import { ComponentProviders } from "../providers/ComponentProviders.js"

/**
 * Base class for a debugger — a bundle of Panels + StatusWidgets focused on
 * one feature area of the WIRE cluster.
 *
 * Two kinds exist:
 *   - Core debuggers (`core = true`) are always active. `ProcessMonitor` is
 *     the only one today — without it the TUI has nothing to show.
 *   - Feature debuggers opt in via registration and can be toggled at
 *     runtime. OPPEnvelope is the current example.
 *
 * Subclasses implement `register(providers)` to install their UI
 * contributions. The shell calls it once on bootstrap.
 */
export abstract class FeatureDebugger {
  /** Stable identifier — used for toggling, keying, and logging. */
  abstract readonly id: string
  /** Human-readable name shown in the feature switcher. */
  abstract readonly name: string
  /** Always-on debuggers (like `ProcessMonitor`) mark this true. */
  readonly core: boolean = false

  /**
   * Install this debugger's Panels and StatusWidgets into the registry.
   * Called by `FeatureDebugger.register` — subclasses shouldn't invoke
   * `ComponentProviders.register` from outside this hook.
   */
  abstract register(providers: typeof ComponentProviders): void
}

export namespace FeatureDebugger {
  const registry = new Map<string, FeatureDebugger>()

  /** Add a debugger and let it install its UI contributions. */
  export function add(dbg: FeatureDebugger): FeatureDebugger {
    registry.set(dbg.id, dbg)
    dbg.register(ComponentProviders)
    return dbg
  }

  /** Every registered debugger (core + feature), insertion order. */
  export function all(): readonly FeatureDebugger[] {
    return [...registry.values()]
  }

  /** Lookup by id — useful for activation toggling. */
  export function find(id: string): FeatureDebugger | undefined {
    return registry.get(id)
  }
}
