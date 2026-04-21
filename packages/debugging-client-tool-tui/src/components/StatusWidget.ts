import type React from "react"

/**
 * A small fixed-size element rendered in the status bar.
 *
 * StatusWidgets typically surface one-line summaries (epoch counter,
 * node health badge, etc.). Contributed by core/feature debuggers via
 * `ComponentProviders.register(StatusWidget, ...)`.
 */
export abstract class StatusWidget {
  /** Stable identifier — React key + debug-log prefix. */
  abstract readonly id: string
  /** Larger = earlier in the status bar (left-to-right). */
  readonly priority: number = 0

  /** React subtree mounted inside the status bar slot. */
  abstract render(): React.ReactElement
}
