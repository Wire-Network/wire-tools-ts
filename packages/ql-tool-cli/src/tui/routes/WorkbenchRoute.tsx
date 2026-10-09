import { Either } from "@3fv/prelude-ts"
import { Box, useStdout } from "ink"
import { noop } from "lodash"
import { useStore } from "react-redux"
import { match } from "ts-pattern"

import { CatalogNodeKind, QueryFormatError, QueryFormatter, QueryPager, QueryText, ResultSelection, SelectionFormat } from "@wireio/ql-shared"
import { NestedError } from "@wireio/shared"

import { SavedCommand } from "../../cli/index.js"
import { formatWindowText, parseWindowText, WindowTextSeparator } from "../../utils/index.js"

import { useTerminalSize, useTuiKeys, type TuiKeyEvent } from "../hooks/index.js"
import { KeyScope, TuiAction } from "../keys/index.js"
import { ColumnsModal, ExportModal, FindModal, PromptModal, ValueInspectorModal } from "../modals/index.js"
import {
  ConnectionBar,
  HeaderBar,
  QueryEditorPanel,
  ResultsTabs,
  SchemaTreePanel,
  StatusBar
} from "../panels/index.js"
import { TuiRoute, useTuiNavigation, type TuiNavigation } from "../routing/index.js"
import {
  QueryService,
  TuiServiceId,
  useTuiService,
  type CatalogService,
  type PersistenceService
} from "../services/index.js"
import {
  CatalogActions,
  CatalogState,
  EditorActions,
  FocusArea,
  MessageLevel,
  PromptKind,
  ResultsActions,
  ResultsState,
  ResultsTab,
  TuiModal,
  UiActions,
  selectCursorColumn,
  selectCursorRow,
  selectResultJsonLines,
  selectResultView,
  useAppDispatch,
  useAppSelector,
  type PromptRequest,
  type RootState,
  type TuiDispatch
} from "../store/index.js"

/** Everything the workbench key handler acts on. */
export interface WorkbenchDependencies {
  /** Store dispatch. */
  dispatch: TuiDispatch
  /** Current store state. */
  getState: () => RootState
  /** Query execution / paging / export. */
  query: QueryService
  /** Schema catalog. */
  catalog: CatalogService
  /** Shared stores. */
  persistence: PersistenceService
  /** Route navigation. */
  navigation: TuiNavigation
  /** Raw terminal write (OSC 52 clipboard). */
  writeTerminal: (data: string) => void
  /** Visible lines of the results area (the JSON tab's scroll extent). */
  resultsHeight: number
}

/** OSC 52 clipboard sequence parts. */
const ClipboardPrefix = "\u001b]52;c;"
/** OSC 52 terminator (BEL). */
const ClipboardSuffix = "\u0007"

/**
 * The workbench: schema tree, SQL editor, results tabs, status bar — and the
 * ONE key handler that routes every press by action and focused area (inactive
 * while a modal owns the keys).
 *
 * @returns The route element.
 */
export function WorkbenchRoute() {
  const dispatch = useAppDispatch(),
    store = useStore<RootState>(),
    navigation = useTuiNavigation(),
    query = useTuiService<QueryService>(TuiServiceId.query),
    catalog = useTuiService<CatalogService>(TuiServiceId.catalog),
    persistence = useTuiService<PersistenceService>(TuiServiceId.persistence),
    { write } = useStdout(),
    ui = useAppSelector(state => state.ui),
    size = useTerminalSize(),
    dependencies: WorkbenchDependencies = {
      dispatch,
      getState: store.getState,
      query,
      catalog,
      persistence,
      navigation,
      writeTerminal: write,
      resultsHeight: size.resultsHeight
    }
  useTuiKeys(WorkbenchRoute.scopeFor(ui.focus), event => WorkbenchRoute.handleKey(event, dependencies), ui.modal === TuiModal.none)
  return (
    <Box flexDirection="column">
      <HeaderBar />
      <ConnectionBar />
      <Box>
        <SchemaTreePanel
          focused={ui.focus === FocusArea.schema}
          width={size.schemaWidth}
          height={size.resultsHeight + size.editorHeight}
        />
        <Box flexDirection="column" flexGrow={1}>
          <QueryEditorPanel focused={ui.focus === FocusArea.editor} height={size.editorHeight} />
          {ui.modal === TuiModal.none ? (
            <ResultsTabs focused={ui.focus === FocusArea.grid} height={size.resultsHeight} width={size.columns - size.schemaWidth} />
          ) : (
            WorkbenchRoute.modalFor(ui.modal, ui.prompt, dependencies)
          )}
        </Box>
      </Box>
      <StatusBar />
    </Box>
  )
}

/** The workbench's key routing (plain functions over {@link WorkbenchDependencies}). */
export namespace WorkbenchRoute {
  /** Title of the save-query prompt. */
  export const SaveQueryTitle = "Save the query as"
  /** Title of the offset/limit window prompt. */
  export const WindowPromptTitle = `Server window: offset${WindowTextSeparator}limit (empty = page size / page)`
  /** Warning when the column chooser opens without a result. */
  export const NoColumnsText = "no columns to choose: run a query first"
  /** Warning when the save-query prompt is submitted without a name. */
  export const UnnamedSavedQueryText = "a saved query needs a name"

  /**
   * Title of the filter prompt of `column`.
   *
   * @param column - The cursor column.
   * @returns The title.
   */
  export function filterTitle(column: string): string {
    return `Filter ${column} (contains; this page; empty clears)`
  }

  /**
   * Warning for window prompt text that is not `offset,limit`.
   *
   * @param text - The rejected text.
   * @returns The warning.
   */
  export function notWindowText(text: string): string {
    return `not a window: "${text}" (expected offset${WindowTextSeparator}limit)`
  }

  /**
   * Warning when formatting the SQL failed for a reason other than a parse error.
   *
   * @param error - The failure.
   * @returns The warning.
   */
  export function formatFailedText(error: Error): string {
    return `format failed: ${error.message}`
  }

  /**
   * Messages-tab line after copying a row.
   *
   * @param row - The 0-based row index.
   * @returns `copied row N (TSV)` with the 1-based row number.
   */
  export function copiedRowText(row: number): string {
    return `copied row ${row + 1} (${SelectionFormat.tsv.toUpperCase()})`
  }

  /**
   * The key scope of a focused area (the schema tree uses global bindings + raw keys).
   *
   * @param focus - Focused area.
   * @returns The scope.
   */
  export function scopeFor(focus: FocusArea): KeyScope {
    return match(focus)
      .with(FocusArea.editor, () => KeyScope.editor)
      .with(FocusArea.grid, () => KeyScope.grid)
      .with(FocusArea.schema, () => KeyScope.global)
      .exhaustive()
  }

  /**
   * Route one keypress.
   *
   * @param event - The resolved press.
   * @param dependencies - What it acts on.
   */
  export function handleKey(event: TuiKeyEvent, dependencies: WorkbenchDependencies): void {
    const { dispatch, getState, query, navigation } = dependencies,
      results = () => getState().results
    match(event.action)
      .with(TuiAction.run, () => void query.run())
      .with(TuiAction.retry, () => void query.retry())
      .with(TuiAction.cancel, () => query.cancel())
      .with(TuiAction.focusNext, () => dispatch(UiActions.focusedNext()))
      .with(TuiAction.focusPrevious, () => dispatch(UiActions.focusedPrevious()))
      .with(TuiAction.toggleJson, () => dispatch(UiActions.jsonToggled()))
      .with(TuiAction.toggleRecordView, () => dispatch(UiActions.recordViewToggled()))
      .with(TuiAction.export, () =>
        ResultsState.success(results()) == null
          ? dispatch(UiActions.message(MessageLevel.warn, QueryService.NothingToExportText))
          : dispatch(UiActions.modalOpened(TuiModal.export))
      )
      .with(TuiAction.format, () => formatEditor(dependencies))
      .with(TuiAction.history, () => navigation.push(TuiRoute.history))
      .with(TuiAction.saved, () => navigation.push(TuiRoute.saved))
      .with(TuiAction.profiles, () => navigation.push(TuiRoute.profiles))
      .with(TuiAction.help, () => navigation.push(TuiRoute.help))
      .with(TuiAction.saveQuery, () =>
        dispatch(UiActions.promptOpened({ kind: PromptKind.saveQuery, title: SaveQueryTitle, initial: "" }))
      )
      .with(TuiAction.window, () =>
        dispatch(
          UiActions.promptOpened({
            kind: PromptKind.window,
            title: WindowPromptTitle,
            initial: formatWindowText(results().window)
          })
        )
      )
      .with(TuiAction.sortColumn, () => withCursorColumn(dependencies, column => dispatch(ResultsActions.sortToggled(column))))
      .with(TuiAction.filterColumn, () =>
        withCursorColumn(dependencies, column =>
          dispatch(
            UiActions.promptOpened({
              kind: PromptKind.filter,
              title: filterTitle(column),
              initial: results().filters.find(filter => filter.column === column)?.text ?? "",
              column
            })
          )
        )
      )
      .with(TuiAction.columns, () =>
        ResultsState.success(results()) == null
          ? dispatch(UiActions.message(MessageLevel.warn, NoColumnsText))
          : dispatch(UiActions.modalOpened(TuiModal.columns))
      )
      .with(TuiAction.find, () => dispatch(UiActions.modalOpened(TuiModal.find)))
      .with(TuiAction.inspect, () => dispatch(UiActions.modalOpened(TuiModal.inspector)))
      .with(TuiAction.copy, () => copyRow(dependencies))
      .with(TuiAction.nextPage, () => void query.fetchPage(results().page + 1))
      .with(TuiAction.previousPage, () => void query.fetchPage(results().page - 1))
      .with(TuiAction.firstPage, () => void query.fetchPage(1))
      .with(TuiAction.lastPage, () => void query.fetchPage(ResultsState.pageCount(results())))
      .with(TuiAction.cyclePageSize, () => {
        dispatch(ResultsActions.pageSizeCycled())
        void query.fetchPage(1)
      })
      .with(TuiAction.quit, () => undefined)
      .with(TuiAction.none, () => handleRawKey(event, dependencies))
      .exhaustive()
  }

  /**
   * Submit an open prompt.
   *
   * @param prompt - The prompt.
   * @param text - The entered text.
   * @param dependencies - What it acts on.
   */
  export function submitPrompt(prompt: PromptRequest, text: string, dependencies: WorkbenchDependencies): void {
    const { dispatch, persistence, query, getState } = dependencies
    dispatch(UiActions.modalClosed())
    match(prompt.kind)
      .with(PromptKind.filter, () => dispatch(ResultsActions.filterSet({ column: prompt.column, text })))
      .with(PromptKind.saveQuery, () => {
        const name = text.trim()
        if (name.length === 0) return void dispatch(UiActions.message(MessageLevel.warn, UnnamedSavedQueryText))
        const saved = persistence.saveQuery(name, getState().editor.buffer.text)
        dispatch(UiActions.message(MessageLevel.info, SavedCommand.savedText(saved.name)))
      })
      .with(PromptKind.window, () =>
        parseWindowText(text).match({
          Left: invalid => void dispatch(UiActions.message(MessageLevel.warn, notWindowText(invalid))),
          Right: window => {
            dispatch(ResultsActions.windowSet(window))
            void query.fetchPage(QueryPager.FirstPage)
          }
        })
      )
      .exhaustive()
  }

  /**
   * The modal element of the open modal.
   *
   * @param modal - The open modal.
   * @param prompt - The open prompt (prompt modal).
   * @param dependencies - What submissions act on.
   * @returns The element.
   */
  export function modalFor(modal: TuiModal, prompt: PromptRequest, dependencies: WorkbenchDependencies) {
    const close = () => dependencies.dispatch(UiActions.modalClosed())
    return match(modal)
      .with(TuiModal.export, () => <ExportModal />)
      .with(TuiModal.find, () => <FindModal />)
      .with(TuiModal.columns, () => <ColumnsModal />)
      .with(TuiModal.inspector, () => <ValueInspectorModal />)
      .with(TuiModal.prompt, () => (
        <PromptModal
          title={prompt.title}
          initial={prompt.initial}
          onCancel={close}
          onSubmit={text => submitPrompt(prompt, text, dependencies)}
        />
      ))
      .with(TuiModal.none, () => null)
      .exhaustive()
  }

  /** Unbound keys by focused area: text entry, grid / tree navigation. */
  function handleRawKey(event: TuiKeyEvent, dependencies: WorkbenchDependencies): void {
    const { dispatch, getState } = dependencies,
      { input, key } = event
    match(getState().ui.focus)
      .with(FocusArea.editor, () => dispatch(EditorActions.keyApplied({ input, key })))
      .with(FocusArea.grid, () =>
        getState().ui.tab === ResultsTab.json ? handleJsonKey(event, dependencies) : handleGridKey(event, dependencies)
      )
      .with(FocusArea.schema, () => handleSchemaKey(event, dependencies))
      .exhaustive()
  }

  /** Grid arrows: move the cell cursor over the view. */
  function handleGridKey({ key }: TuiKeyEvent, { dispatch, getState }: WorkbenchDependencies): void {
    const view = selectResultView(getState().results),
      rowDelta = arrowDelta(key.upArrow, key.downArrow),
      columnDelta = arrowDelta(key.leftArrow, key.rightArrow)
    if (view != null && (rowDelta !== 0 || columnDelta !== 0)) {
      dispatch(ResultsActions.cursorMoved({ rowDelta, columnDelta, rowCount: view.rowCount, columnCount: view.columns.length }))
    }
  }

  /** JSON tab ↑↓: scroll its lines (its own offset — the grid cursor indexes rows). */
  function handleJsonKey({ key }: TuiKeyEvent, { dispatch, getState, resultsHeight }: WorkbenchDependencies): void {
    const delta = arrowDelta(key.upArrow, key.downArrow)
    if (delta !== 0) {
      const lineCount = selectResultJsonLines(getState().results).length
      dispatch(ResultsActions.jsonScrolled({ delta, lineCount, height: resultsHeight }))
    }
  }

  /** -1, +1 or 0 for a pair of opposite arrows. */
  function arrowDelta(backward: boolean, forward: boolean): number {
    return backward ? -1 : forward ? 1 : 0
  }

  /** Schema tree keys: ↑↓ move, Enter expand owner / insert table, → expand table, {@link SchemaTreePanel.DescribeInput} describe. */
  function handleSchemaKey(event: TuiKeyEvent, dependencies: WorkbenchDependencies): void {
    const { dispatch, getState, catalog } = dependencies,
      state = getState().catalog,
      row = CatalogState.treeRows(state)[state.cursor]
    match(event)
      .with({ key: { upArrow: true } }, () => dispatch(CatalogActions.cursorMoved(-1)))
      .with({ key: { downArrow: true } }, () => dispatch(CatalogActions.cursorMoved(1)))
      .when(() => row == null, noop)
      .with({ key: { return: true } }, () =>
        row.kind === CatalogNodeKind.owner
          ? dispatch(CatalogActions.nodeToggled(row.key))
          : row.table != null && dispatch(EditorActions.textInserted(QueryText.qualifyTable(row.owner, row.table)))
      )
      .with({ key: { rightArrow: true } }, () => row.kind === CatalogNodeKind.table && dispatch(CatalogActions.nodeToggled(row.key)))
      .with({ input: SchemaTreePanel.DescribeInput }, () => row.table != null && void catalog.describe(row.owner, row.table))
      .otherwise(noop)
  }

  /** Alt+F: format the editor SQL (an unparsable query is reported, the text kept). */
  function formatEditor({ dispatch, getState }: WorkbenchDependencies): void {
    Either.try(() => QueryFormatter.format(getState().editor.buffer.text)).match({
      Left: error =>
        void dispatch(
          UiActions.message(
            MessageLevel.warn,
            error instanceof QueryFormatError ? error.message : formatFailedText(NestedError.toError(error))
          )
        ),
      Right: formatted => void dispatch(EditorActions.textReplaced(formatted))
    })
  }

  /** `y`: copy the cursor row as TSV through the terminal clipboard (OSC 52). */
  function copyRow({ dispatch, getState, writeTerminal }: WorkbenchDependencies): void {
    const results = getState().results,
      row = selectCursorRow(results)
    if (row == null) return
    const text = ResultSelection.row(selectResultView(results), row, SelectionFormat.tsv)
    writeTerminal(`${ClipboardPrefix}${Buffer.from(text, "utf8").toString("base64")}${ClipboardSuffix}`)
    dispatch(UiActions.message(MessageLevel.info, copiedRowText(row)))
  }

  /** Run `act` with the cursor column's name (no-op without a result). */
  function withCursorColumn({ getState }: WorkbenchDependencies, act: (column: string) => void): void {
    const results = getState().results,
      column = selectCursorColumn(results)
    if (column != null) act(selectResultView(results).columns[column].name)
  }
}
