import React from "react"

export type StatusBarComponentProps = React.PropsWithChildren<{}>

/**
 * A small fixed-size element rendered in the status bar.
 *
 * StatusWidgets typically surface one-line summaries (epoch counter,
 * node health badge, etc.). Contributed by core/feature debuggers via
 * `ComponentProviders.register(StatusWidget, ...)`.
 */

export interface StatusBarComponentType<
  Props extends StatusBarComponentProps = StatusBarComponentProps
> extends React.FunctionComponent<Props> {
  /** Stable identifier — React key + debug-log prefix. */
  readonly id: string
}
