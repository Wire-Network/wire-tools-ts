import { noop } from "lodash"
import { match } from "ts-pattern"

import type { SavedQuery } from "@wireio/ql-shared"

import { SavedCommand } from "../../cli/index.js"
import type { TuiKeyEvent } from "../hooks/index.js"
import { KeyBindings, TuiAction } from "../keys/index.js"
import { useTuiNavigation } from "../routing/index.js"
import { TuiServiceId, useTuiService, type PersistenceService, type QueryService } from "../services/index.js"
import { SavedActions, useAppDispatch, useAppSelector } from "../store/index.js"
import { ListRoute, type QueryLoadTarget } from "./ListRoute.js"

/** What the Saved-queries route acts on. */
export interface SavedQueriesRouteDependencies extends QueryLoadTarget {
  /** The shared stores (remove). */
  persistence: PersistenceService
}

/** `r` runs the selected query. */
const RunInput = "r"
/** `x` removes the selected query. */
const RemoveInput = "x"

/**
 * Saved queries (the shared `saved-queries.json`): Enter loads into the editor,
 * `r` loads and runs, `x` removes, Esc returns. Alt+W in the workbench saves.
 *
 * @returns The route element.
 */
export function SavedQueriesRoute() {
  const dispatch = useAppDispatch(),
    query = useTuiService<QueryService>(TuiServiceId.query),
    persistence = useTuiService<PersistenceService>(TuiServiceId.persistence),
    navigation = useTuiNavigation(),
    { items, cursor } = useAppSelector(state => state.saved),
    dependencies: SavedQueriesRouteDependencies = { dispatch, query, navigation, persistence }
  return (
    <ListRoute
      title={SavedQueriesRoute.Title}
      emptyText={SavedQueriesRoute.EmptyText}
      keysHint={SavedQueriesRoute.KeysHint}
      items={items}
      cursor={cursor}
      itemKey={saved => saved.id}
      rowText={SavedCommand.savedLine}
      onCursorMoved={delta => dispatch(SavedActions.cursorMoved(delta))}
      onKey={(event, selected) => SavedQueriesRoute.handleKey(event, selected, dependencies)}
    />
  )
}

/** Saved-queries route key handling. */
export namespace SavedQueriesRoute {
  /** Title. */
  export const Title = "Saved queries"
  /** Shown without saved queries. */
  export const EmptyText = `no saved queries — ${KeyBindings.labelOf(TuiAction.saveQuery)} in the workbench saves the editor's query`
  /** Key hint. */
  export const KeysHint = ListRoute.keysHint([ListRoute.LoadHint, `${RunInput} run`, `${RemoveInput} remove`])

  /**
   * Route one keypress (Esc and ↑↓ are the list's).
   *
   * @param event - The resolved press.
   * @param selected - The saved query under the cursor (undefined when none).
   * @param dependencies - What it acts on.
   */
  export function handleKey(event: TuiKeyEvent, selected: SavedQuery, dependencies: SavedQueriesRouteDependencies): void {
    match(event)
      .when(() => selected == null, noop)
      .with({ input: RemoveInput }, () => dependencies.persistence.removeSavedQuery(selected.id))
      .with({ key: { return: true } }, () => ListRoute.loadQuery(dependencies, selected.query, false))
      .with({ input: RunInput }, () => ListRoute.loadQuery(dependencies, selected.query, true))
      .otherwise(noop)
  }
}
