import { Panel } from "../components/Panel.js"
import { StatusWidget } from "../components/StatusWidget.js"

/** Constructor token accepted by `register`/`get` — works on abstract bases too. */
type Ctor<T> = abstract new (...args: any[]) => T

/**
 * Global registry of UI component contributions. Debuggers (core + feature)
 * register Panel and StatusWidget instances; the shell queries them by base
 * class token to build the layout.
 *
 * Usage:
 *   ComponentProviders.register(Panel, new ProcessMonitorPanel())
 *   const panels = ComponentProviders.get(Panel)
 *   const widgets = ComponentProviders.get(StatusWidget)
 */
class ComponentProvidersRegistry {
  private readonly byToken = new Map<Ctor<unknown>, unknown[]>()

  /** Append an instance under its base-class token. */
  register<T>(token: Ctor<T>, instance: T): this {
    const arr = (this.byToken.get(token) as T[] | undefined) ?? []
    arr.push(instance)
    this.byToken.set(token, arr)
    return this
  }

  /**
   * Return every instance registered under a token, sorted by descending
   * `priority` (missing priorities default to 0).
   */
  get<T>(token: Ctor<T>): T[] {
    const arr = (this.byToken.get(token) as T[] | undefined) ?? []
    return arr
      .slice()
      .sort((a, b) => (asPriority(b) ?? 0) - (asPriority(a) ?? 0))
  }

  /** Drop every registration for a token — used in tests and hot-reload. */
  clear<T>(token: Ctor<T>): this {
    this.byToken.delete(token)
    return this
  }
}

function asPriority(instance: unknown): number | undefined {
  return typeof instance === "object" &&
    instance !== null &&
    "priority" in instance
    ? ((instance as { priority?: number }).priority ?? undefined)
    : undefined
}

/** Process-wide registry singleton. */
export const ComponentProviders = new ComponentProvidersRegistry()

export { Panel, StatusWidget }
