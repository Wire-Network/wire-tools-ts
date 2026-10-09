import type { ReactNode } from "react"
import { Box, Text } from "ink"
import { match } from "ts-pattern"

import { ResultSummary } from "@wireio/ql-shared"

import { WindowedList } from "../components/index.js"
import { useTerminalSize, useTuiKeys, type TuiKeyEvent } from "../hooks/index.js"
import { KeyBindings, KeyName, KeyScope, TuiAction } from "../keys/index.js"
import { HeaderBar } from "../panels/index.js"
import { useTuiNavigation, type TuiNavigation } from "../routing/index.js"
import type { QueryService } from "../services/index.js"
import { EditorActions, type TuiDispatch } from "../store/index.js"

/** Props of {@link ListRoute}. */
export interface ListRouteProps<T> {
  /** Title line. */
  title: string
  /** Shown without items. */
  emptyText: string
  /** Key hint line. */
  keysHint: string
  /** The items, in display order. */
  items: readonly T[]
  /** Cursor index. */
  cursor: number
  /** React key of a row. */
  itemKey(item: T, index: number): string
  /** Text of a row. */
  rowText(item: T): string
  /** ↑ / ↓ moved the cursor by `delta`. */
  onCursorMoved(delta: number): void
  /** Any other press (after Esc and the arrows), with the item under the cursor (undefined when none). */
  onKey(event: TuiKeyEvent, selected: T): void
  /** Whether the list listens (false while a modal of the route owns the keys; default true). */
  isActive?: boolean
  /** The route's modal, rendered above the hint. */
  children?: ReactNode
}

/** What {@link ListRoute.loadQuery} acts on. */
export interface QueryLoadTarget {
  /** Store dispatch. */
  dispatch: TuiDispatch
  /** Navigation (back to the workbench). */
  navigation: TuiNavigation
  /** Query execution. */
  query: QueryService
}

/**
 * The ONE list-route template (History, Saved, Profiles): header, title,
 * windowed rows with the cursor inverse, the route's modal, and the key hint;
 * Esc returns, ↑↓ move, every other press goes to the route.
 *
 * @param props - Items, cursor, rendering and handlers.
 * @returns The route element.
 */
export function ListRoute<T>(props: ListRouteProps<T>) {
  const { title, emptyText, keysHint, items, cursor, itemKey, rowText, isActive = true, children } = props,
    navigation = useTuiNavigation(),
    size = useTerminalSize(),
    visible = WindowedList.window(items, cursor, size.rows - ListRoute.ChromeRows)
  useTuiKeys(KeyScope.global, event => ListRoute.handleKey(event, props, navigation), isActive)
  return (
    <Box flexDirection="column">
      <HeaderBar />
      <Text bold>{title}</Text>
      {items.length === 0 && <Text dimColor>{emptyText}</Text>}
      {visible.items.map((item, index) => (
        <Text key={itemKey(item, visible.offset + index)} inverse={visible.offset + index === cursor} wrap="truncate">
          {rowText(item)}
        </Text>
      ))}
      {children}
      <Text dimColor>{keysHint}</Text>
    </Box>
  )
}

/** List-route constants and key routing. */
export namespace ListRoute {
  /** Rows of header, title and hint. */
  export const ChromeRows = 4
  /** Hint part of the cursor keys. */
  export const MoveHint = `${KeyBindings.UpDownLabel} move`
  /** Hint part of Enter loading the selected entry into the editor (History, Saved). */
  export const LoadHint = KeyBindings.hint(KeyBindings.namedChord(KeyName.return), "load")

  /**
   * Route one keypress: Esc pops back, ↑↓ move, anything else goes to the route.
   *
   * @param event - The resolved press.
   * @param props - The list's items, cursor and handlers.
   * @param navigation - Navigation.
   */
  export function handleKey<T>(event: TuiKeyEvent, props: ListRouteProps<T>, navigation: TuiNavigation): void {
    match(event)
      .with({ action: TuiAction.cancel }, () => navigation.pop())
      .with({ key: { upArrow: true } }, () => props.onCursorMoved(-1))
      .with({ key: { downArrow: true } }, () => props.onCursorMoved(1))
      .otherwise(() => props.onKey(event, props.items[props.cursor]))
  }

  /**
   * Load `text` into the editor and return to the workbench, running it when asked
   * (the Enter / `r` of History and Saved).
   *
   * @param target - Dispatch, navigation and query execution.
   * @param text - The SQL.
   * @param run - Whether to run it.
   */
  export function loadQuery({ dispatch, navigation, query }: QueryLoadTarget, text: string, run: boolean): void {
    dispatch(EditorActions.textReplaced(text))
    navigation.pop()
    if (run) void query.run(text)
  }

  /**
   * The hint of a route's keys: {@link MoveHint}, the route's own parts, then the back key.
   *
   * @param parts - The route's key parts (`Enter load`, `r rerun`).
   * @returns The hint.
   */
  export function keysHint(parts: readonly string[]): string {
    return ResultSummary.join([MoveHint, ...parts, `${KeyBindings.labelOf(TuiAction.cancel)} back`])
  }
}
