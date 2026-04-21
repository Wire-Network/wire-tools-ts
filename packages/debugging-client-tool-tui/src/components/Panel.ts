import type React from "react"

/**
 * A resizable region in the main layout that hosts a React subtree.
 *
 * Concrete subclasses are contributed by core or feature debuggers and
 * surfaced via `ComponentProviders.get(Panel)`. Panel's `render()` is
 * invoked inside an Ink `Box` whose dimensions are managed by the shell.
 */
export abstract class Panel {
  /** Stable identifier — React key + debug-log prefix. */
  abstract readonly id: string
  /** Short human-readable title shown in the panel header. */
  abstract readonly title: string
  /**
   * Relative flex weight within a tiled panel row/column.
   * Higher values consume more terminal real estate.
   */
  readonly flex: number = Panel.DefaultFlex
  /** Larger = earlier in the panel list (render order). */
  readonly priority: number = 0

  /** React subtree mounted inside the panel's Box. */
  abstract render(): React.ReactElement
}

export namespace Panel {
  /** Default flex weight if a subclass doesn't override. */
  export const DefaultFlex = 1
}
