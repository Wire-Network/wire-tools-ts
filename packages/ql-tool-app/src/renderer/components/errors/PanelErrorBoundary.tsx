import { Component, type ErrorInfo, type ReactNode } from "react"
import Alert from "@mui/material/Alert"
import Button from "@mui/material/Button"

import { getLogger } from "@wireio/shared"

const log = getLogger(__filename)

/** Props of {@link PanelErrorBoundary}. */
export interface PanelErrorBoundaryProps {
  /** Panel name (in the fallback text and the log). */
  panel: string
  /** The panel. */
  children: ReactNode
}

/** State of {@link PanelErrorBoundary}. */
export interface PanelErrorBoundaryState {
  /** The render error, if the panel failed. */
  error: Error
}

/**
 * Isolates one panel (root, navigator, each editor / results tab): a render error
 * is logged and replaced by an inline "This panel failed — Reload panel" with the
 * message, instead of blanking the window. (Error boundaries are the one place
 * React still requires a class component.)
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  /** Initial state. */
  state: PanelErrorBoundaryState = { error: null }

  /**
   * Capture the render error.
   *
   * @param error - The error.
   * @returns The new state.
   */
  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { error }
  }

  /**
   * Log the failure.
   *
   * @param error - The error.
   * @param info - React's component stack.
   */
  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error(`${this.props.panel} panel failed: ${error.message}`, error, info.componentStack ?? "")
  }

  /** Render the panel or its fallback. */
  render(): ReactNode {
    const { error } = this.state
    if (error == null) return this.props.children
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" onClick={() => this.setState({ error: null })}>
            {PanelErrorBoundary.ReloadLabel}
          </Button>
        }
      >
        {`${this.props.panel}: ${PanelErrorBoundary.FailedText} — ${error.message}`}
      </Alert>
    )
  }
}

/** Fallback texts. */
export namespace PanelErrorBoundary {
  /** Fallback headline. */
  export const FailedText = "This panel failed"
  /** Reload button label. */
  export const ReloadLabel = "Reload panel"
}
