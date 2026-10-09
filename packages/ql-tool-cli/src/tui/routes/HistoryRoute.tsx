import { useState } from "react"
import { noop } from "lodash"
import { match } from "ts-pattern"

import type { QueryHistoryEntry } from "@wireio/ql-shared"

import { HistoryCommand } from "../../cli/index.js"
import type { TuiKeyEvent } from "../hooks/index.js"
import { KeyBindings, KeyName } from "../keys/index.js"
import { PromptModal } from "../modals/index.js"
import { useTuiNavigation } from "../routing/index.js"
import { TuiServiceId, useTuiService, type PersistenceService, type QueryService } from "../services/index.js"
import { HistoryActions, MessageLevel, UiActions, useAppDispatch, useAppSelector } from "../store/index.js"
import { ListRoute, type QueryLoadTarget } from "./ListRoute.js"

/** What the History route acts on. */
export interface HistoryRouteDependencies extends QueryLoadTarget {
  /** The shared stores (clear). */
  persistence: PersistenceService
  /** Open the clear-history confirmation. */
  confirmClear: () => void
}

/** `r` reruns the selected entry. */
const RerunInput = "r"
/** `c` asks to clear the whole history. */
const ClearInput = "c"

/**
 * Executed queries, newest first (the shared `history.jsonl`): Enter loads the
 * query into the editor, `r` loads and reruns it, `c` clears the whole history
 * after a confirmation prompt, Esc returns.
 *
 * @returns The route element.
 */
export function HistoryRoute() {
  const dispatch = useAppDispatch(),
    query = useTuiService<QueryService>(TuiServiceId.query),
    persistence = useTuiService<PersistenceService>(TuiServiceId.persistence),
    navigation = useTuiNavigation(),
    { items, cursor } = useAppSelector(state => state.history),
    [confirming, setConfirming] = useState(false),
    dependencies: HistoryRouteDependencies = { dispatch, query, navigation, persistence, confirmClear: () => setConfirming(true) }
  return (
    <ListRoute
      title={HistoryRoute.Title}
      emptyText={HistoryRoute.EmptyText}
      keysHint={HistoryRoute.KeysHint}
      items={items}
      cursor={cursor}
      itemKey={(entry, index) => `${entry.id}-${index}`}
      rowText={HistoryCommand.entryLine}
      onCursorMoved={delta => dispatch(HistoryActions.cursorMoved(delta))}
      onKey={(event, selected) => HistoryRoute.handleKey(event, selected, dependencies)}
      isActive={!confirming}
    >
      {confirming && (
        <PromptModal
          title={HistoryRoute.ClearConfirmTitle}
          initial=""
          hint={HistoryRoute.ClearConfirmHint}
          onCancel={() => setConfirming(false)}
          onSubmit={text => {
            setConfirming(false)
            HistoryRoute.submitClear(text, dependencies)
          }}
        />
      )}
    </ListRoute>
  )
}

/** History route key handling. */
export namespace HistoryRoute {
  /** Title. */
  export const Title = "History (newest first)"
  /** Shown without entries. */
  export const EmptyText = "no executed queries yet"
  /** Key hint. */
  export const KeysHint = ListRoute.keysHint([ListRoute.LoadHint, `${RerunInput} rerun`, `${ClearInput} clear`])
  /** Title of the clear confirmation. */
  export const ClearConfirmTitle = "Clear the whole history? (shared with wql and the desktop app)"
  /** The confirmation answer that clears. */
  export const ClearConfirmAnswer = "yes"
  /** Hint of the clear confirmation. */
  export const ClearConfirmHint = `type ${ClearConfirmAnswer} and ${KeyBindings.namedLabel(KeyName.return)} to clear; anything else keeps it`
  /** Messages-tab line when the confirmation keeps the history. */
  export const KeptText = "history kept"

  /**
   * Route one keypress (Esc and ↑↓ are the list's).
   *
   * @param event - The resolved press.
   * @param selected - The entry under the cursor (undefined when none).
   * @param dependencies - What it acts on.
   */
  export function handleKey(event: TuiKeyEvent, selected: QueryHistoryEntry, dependencies: HistoryRouteDependencies): void {
    match(event)
      .with({ input: ClearInput }, () => dependencies.confirmClear())
      .when(() => selected == null, noop)
      .with({ key: { return: true } }, () => ListRoute.loadQuery(dependencies, selected.query, false))
      .with({ input: RerunInput }, () => ListRoute.loadQuery(dependencies, selected.query, true))
      .otherwise(noop)
  }

  /**
   * Answer the clear confirmation: exactly {@link ClearConfirmAnswer} (case-
   * and space-insensitive) clears the shared history; anything else keeps it.
   *
   * @param text - The typed answer.
   * @param dependencies - What it acts on.
   */
  export function submitClear(text: string, { dispatch, persistence }: HistoryRouteDependencies): void {
    const confirmed = text.trim().toLowerCase() === ClearConfirmAnswer
    if (confirmed) persistence.clearHistory()
    dispatch(UiActions.message(MessageLevel.info, confirmed ? HistoryCommand.ClearedText : KeptText))
  }
}
