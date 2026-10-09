import { useEffect, useRef } from "react"
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react"
import type * as Monaco from "monaco-editor"

import { QueryExecutionStatus, QueryFailureKind, type CatalogSnapshot } from "@wireio/ql-shared"

import { AppAction } from "../../common/index.js"
import {
  formatQuery,
  runQuery,
  selectActiveEditorTab,
  useAppDispatch,
  useAppSelector,
  WorkspaceActions,
  type AppThunk
} from "../store/index.js"
import { Diagnostics, EditorChords, MonacoOptions, useMonacoTheme, WireQueryLanguage } from "./monaco/index.js"

/** The registered language's providers (registered once per Monaco instance). */
let languageRegistration: Monaco.IDisposable = null
/** The snapshot the providers read (updated by every QueryEditor render). */
let currentSnapshot: CatalogSnapshot = null

/**
 * The Monaco `wirequery` editor bound to the focused editor tab: semantic
 * tokens, completion and hover from the catalog, debounced grammar markers,
 * the last engine failure as a marker, the {@link QueryEditor.ChordThunks}
 * keybindings (chords from the action registry) and the Monaco theme following
 * the OS scheme.
 */
export function QueryEditor() {
  const dispatch = useAppDispatch(),
    tab = useAppSelector(state => selectActiveEditorTab(state.workspace)),
    snapshot = useAppSelector(state => state.catalog.snapshot),
    failedRun = useAppSelector(state =>
      state.results.tabs.find(
        result =>
          result.sourceEditorId === tab.id &&
          result.execution?.status === QueryExecutionStatus.failure &&
          result.execution.failure.kind === QueryFailureKind.engine
      )
    ),
    theme = useMonacoTheme(),
    editorRef = useRef<Monaco.editor.IStandaloneCodeEditor>(null),
    monacoRef = useRef<typeof Monaco>(null),
    tabIdRef = useRef(tab.id)
  currentSnapshot = snapshot
  tabIdRef.current = tab.id

  // The language must exist BEFORE the model is created with it.
  const beforeMount: BeforeMount = monaco => {
    if (languageRegistration == null) languageRegistration = WireQueryLanguage.register(monaco, () => currentSnapshot)
  }

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    EditorChords.register(editor, monaco, QueryEditor.ChordActions, action => void dispatch(QueryEditor.ChordThunks[action]()))
    editor.onDidChangeCursorSelection(event => {
      const model = editor.getModel()
      if (model == null) return
      const start = model.getOffsetAt(event.selection.getStartPosition()),
        end = model.getOffsetAt(event.selection.getEndPosition())
      dispatch(
        WorkspaceActions.selectionChanged({ id: tabIdRef.current, selection: start === end ? null : { start, end } })
      )
    })
    editor.focus()
  }

  // Grammar markers, debounced while typing.
  useEffect(() => {
    const model = editorRef.current?.getModel(),
      monaco = monacoRef.current
    if (model == null || monaco == null) return
    const timer = setTimeout(() => Diagnostics.applyGrammarMarkers(monaco, model), Diagnostics.DebounceMs)
    return () => clearTimeout(timer)
  }, [tab.text, tab.id])

  // The last engine failure of this tab's run, as a marker.
  useEffect(() => {
    const model = editorRef.current?.getModel(),
      monaco = monacoRef.current
    if (model == null || monaco == null) return
    const execution = failedRun?.execution
    Diagnostics.applyEngineFailure(
      monaco,
      model,
      execution?.status === QueryExecutionStatus.failure ? execution.failure : null,
      failedRun?.query ?? ""
    )
  }, [failedRun, tab.id])

  return (
    <Editor
      path={tab.id}
      language={WireQueryLanguage.Id}
      value={tab.text}
      theme={theme}
      beforeMount={beforeMount}
      onMount={onMount}
      onChange={text => dispatch(WorkspaceActions.textChanged({ id: tabIdRef.current, text: text ?? "" }))}
      options={QueryEditor.Options}
    />
  )
}

/** The query editor's chords and options. */
export namespace QueryEditor {
  /**
   * What each editor chord runs, keyed by action (the chord itself is the
   * action's registry accelerator). Inside the editor Monaco consumes these
   * keys, so the menu accelerator of the same chord does not fire a second time.
   */
  export const ChordThunks: Readonly<Partial<Record<AppAction, () => AppThunk>>> = {
    [AppAction.run]: () => runQuery(false),
    [AppAction.runSelection]: () => runQuery(true),
    [AppAction.formatQuery]: () => formatQuery()
  }
  /** The actions bound as editor chords. */
  export const ChordActions = Object.keys(ChordThunks) as AppAction[]
  /** Editor options: the shared base plus semantic highlighting and SQL-editor tweaks. */
  export const Options: Monaco.editor.IStandaloneEditorConstructionOptions = {
    ...MonacoOptions.base,
    [WireQueryLanguage.SemanticHighlightingOption]: true,
    renderLineHighlight: "line",
    wordBasedSuggestions: "off"
  }
}
