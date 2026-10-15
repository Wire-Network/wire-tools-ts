import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import { findTab, nextActive } from "../common/index.js"
import { SliceName } from "../SliceName.js"

/** A selection in an editor buffer (0-based offsets, `start <= end`). */
export interface EditorSelection {
  /** Start offset. */
  start: number
  /** End offset (exclusive). */
  end: number
}

/** One SQL editor tab. */
export interface EditorTab {
  /** Stable id. */
  id: string
  /** Tab label. */
  title: string
  /** SQL text. */
  text: string
  /** The `.sql` file it was opened from / saved to (null = untitled). */
  filePath: string
  /** Current selection (null = caret only). */
  selection: EditorSelection
}

/** Editor tabs. */
export interface WorkspaceState {
  /** Open tabs in order. */
  tabs: EditorTab[]
  /** The focused tab. */
  activeTabId: string
  /** Counter behind ids and "Query N" titles. */
  nextTabNumber: number
}

/** A new tab's optional contents. */
export interface EditorTabSeed {
  /** Initial SQL. */
  text?: string
  /** Label (default "Query N"). */
  title?: string
  /** Source file. */
  filePath?: string
}

/** A text change. */
export interface EditorTextChange {
  /** Tab id. */
  id: string
  /** New text. */
  text: string
}

/** A selection change. */
export interface EditorSelectionChange {
  /** Tab id. */
  id: string
  /** New selection (null = caret). */
  selection: EditorSelection
}

/** A tab now backed by a file. */
export interface EditorFileAssociation {
  /** Tab id. */
  id: string
  /** The file. */
  filePath: string
}

/** Workspace constants + helpers. */
export namespace Workspace {
  /** Title prefix of untitled tabs. */
  export const UntitledPrefix = "Query"
  /** Tab id prefix. */
  export const TabIdPrefix = "editor-"

  /**
   * A new tab.
   *
   * @param number - Its sequence number.
   * @param seed - Optional contents.
   * @returns The tab.
   */
  export function createTab(number: number, seed: EditorTabSeed = {}): EditorTab {
    const { text = "", title = `${UntitledPrefix} ${number}`, filePath = null } = seed
    return { id: `${TabIdPrefix}${number}`, title, text, filePath, selection: null }
  }

  /**
   * The text a run executes: the selection when asked and non-empty, else the whole buffer (trimmed).
   *
   * @param tab - The tab.
   * @param selectionOnly - "Run selection".
   * @returns The SQL to run.
   */
  export function queryText(tab: EditorTab, selectionOnly: boolean): string {
    const { selection, text } = tab,
      selected = selection != null && selection.end > selection.start ? text.slice(selection.start, selection.end) : ""
    return (selectionOnly && selected.trim().length > 0 ? selected : text).trim()
  }

  /**
   * File name of a path (either separator).
   *
   * @param filePath - A path.
   * @returns Its last segment.
   */
  export function baseName(filePath: string): string {
    return filePath.split(/[\\/]/).pop()
  }
}

/**
 * The initial workspace: one empty tab.
 *
 * @returns The state.
 */
export function createWorkspaceInitialState(): WorkspaceState {
  const first = Workspace.createTab(1)
  return { tabs: [first], activeTabId: first.id, nextTabNumber: 2 }
}

/** Workspace (editor tabs) slice. */
export const WorkspaceSlice = createSlice({
  name: SliceName.workspace,
  initialState: createWorkspaceInitialState(),
  reducers: {
    /** Open a tab and focus it. */
    tabAdded(state, action: PayloadAction<EditorTabSeed>) {
      const tab = Workspace.createTab(state.nextTabNumber, action.payload)
      state.tabs.push(tab)
      state.activeTabId = tab.id
      state.nextTabNumber += 1
    },
    /** Close a tab (the last tab is replaced by an empty one). */
    tabClosed(state, action: PayloadAction<string>) {
      const index = state.tabs.findIndex(tab => tab.id === action.payload)
      if (index < 0) return
      state.tabs.splice(index, 1)
      if (state.tabs.length === 0) {
        state.tabs.push(Workspace.createTab(state.nextTabNumber))
        state.nextTabNumber += 1
      }
      if (state.activeTabId === action.payload) state.activeTabId = nextActive(state.tabs, index)
    },
    /** Focus a tab. */
    tabActivated(state, action: PayloadAction<string>) {
      if (findTab(state.tabs, action.payload) != null) state.activeTabId = action.payload
    },
    /** The editor text changed. */
    textChanged(state, action: PayloadAction<EditorTextChange>) {
      const tab = findTab(state.tabs, action.payload.id)
      if (tab != null) tab.text = action.payload.text
    },
    /** The editor selection changed. */
    selectionChanged(state, action: PayloadAction<EditorSelectionChange>) {
      const tab = findTab(state.tabs, action.payload.id)
      if (tab != null) tab.selection = action.payload.selection
    },
    /** The tab was opened from / saved to a file. */
    fileAssociated(state, action: PayloadAction<EditorFileAssociation>) {
      const tab = findTab(state.tabs, action.payload.id)
      if (tab == null) return
      tab.filePath = action.payload.filePath
      tab.title = Workspace.baseName(action.payload.filePath)
    }
  }
})

/** Workspace actions. */
export const WorkspaceActions = WorkspaceSlice.actions

/**
 * The focused editor tab.
 *
 * @param state - Workspace state.
 * @returns The tab.
 */
export function selectActiveEditorTab(state: WorkspaceState): EditorTab {
  return findTab(state.tabs, state.activeTabId)
}
