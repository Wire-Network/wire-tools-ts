import type { QueryExecution } from "@wireio/ql-shared"

import { ConnectionActions, createTuiStore, ResultsActions, type TuiStore } from "@wireio/ql-tool-cli/tui/index.js"

import { successExecution } from "./engineFixtures.js"

/** The profile of {@link storeWithResult}. */
export const FixtureProfile = { name: "local", endpoint: "http://node.example", transportTimeoutMs: 1_000, retries: 0 }

/**
 * A store whose last run finished with `execution` (default: the 3-row sample) on {@link FixtureProfile}.
 *
 * @param execution - The finished execution.
 * @returns The store.
 */
export function storeWithResult(execution: QueryExecution = successExecution()): TuiStore {
  const store = createTuiStore()
  store.dispatch(ConnectionActions.profileSelected(FixtureProfile))
  store.dispatch(ResultsActions.runStarted(execution.query))
  store.dispatch(ResultsActions.runFinished(execution))
  return store
}
