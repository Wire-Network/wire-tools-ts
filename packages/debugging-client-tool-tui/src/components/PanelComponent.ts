import React from "react"

export type PanelComponentProps = React.PropsWithChildren<{}>

/**
 * A resizable region in the main layout that hosts a React subtree.
 *
 * Concrete subclasses are contributed by core or feature debuggers and
 * surfaced via `ComponentProviders.get(Panel)`. Panel's `render()` is
 * invoked inside an Ink `Box` whose dimensions are managed by the shell.
 */
export interface PanelComponentType<
  Props extends PanelComponentProps = PanelComponentProps
> extends React.FunctionComponent<Props> {
  /** Stable identifier — React key + debug-log prefix. */
  readonly id: string
  /** Short human-readable title shown in the panel header. */
  readonly title: string
}
