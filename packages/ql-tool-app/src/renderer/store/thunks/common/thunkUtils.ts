import { getLogger, NestedError } from "@wireio/shared"

import type { AppDispatch, AppThunk } from "../../Store.js"
import { UiActions } from "../../ui/UiSlice.js"

const log = getLogger(__filename)

/** What a guarded thunk's failure reports. */
export interface GuardedFailure {
  /** What was attempted ("Loading history", "describing sample.positions", …). */
  label: string
  /** The error's message. */
  message: string
  /** The caught value (its stack and cause chain intact). */
  error: unknown
}

/** Reports a guarded thunk's failure in the UI (after it was logged). */
export type GuardedFailureReporter = (dispatch: AppDispatch, failure: GuardedFailure) => void

/** The stock {@link GuardedFailureReporter}s. */
export namespace GuardedReport {
  /**
   * Show `<label> failed: <message>` as the workbench notice.
   *
   * @param dispatch - The store's dispatch.
   * @param failure - The failure.
   */
  export function notice(dispatch: AppDispatch, failure: GuardedFailure): void {
    dispatch(UiActions.noticeChanged(`${failure.label} failed: ${failure.message}`))
  }

  /** Report nothing beyond the log line (a background chore the user did not ask for). */
  export function logOnly(): void {
    return undefined
  }
}

/**
 * Run a thunk so that its failure is logged with the error and reported, never
 * left as an unhandled rejection — the ONE error boundary of the workbench thunks.
 *
 * @param label - What is attempted (the log line and the default notice start with it).
 * @param operation - The guarded work.
 * @param report - How the UI hears of a failure (default: a notice).
 * @returns The thunk.
 */
export function guarded(label: string, operation: AppThunk, report: GuardedFailureReporter = GuardedReport.notice): AppThunk {
  return async (dispatch, getState, services) => {
    try {
      await operation(dispatch, getState, services)
    } catch (error) {
      const message = NestedError.toError(error).message
      log.warn(`${label} failed: ${message}`, error)
      report(dispatch, { label, message, error })
    }
  }
}
