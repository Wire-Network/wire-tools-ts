/**
 * @jest-environment jsdom
 */
import { fireEvent, screen, waitFor } from "@testing-library/react"

import { AppAction, IPCChannel } from "@wireio/ql-tool-app/common"
import { EditorTabs, QueryEditor } from "@wireio/ql-tool-app/renderer/editor"
import { MonacoOptions, WireQueryLanguage } from "@wireio/ql-tool-app/renderer/editor/monaco"
import { ConnectionsActions, selectActiveEditorTab } from "@wireio/ql-tool-app/renderer/store"

import { mountedEditors } from "../../__mocks__/@monaco-editor/react.js"
import * as monacoMock from "../../__mocks__/monaco-editor.js"
import { ExecutionFixtures } from "../../common/ExecutionFixtures.js"
import { FakeWorkbench } from "../../common/FakeWorkbench.js"
import { RenderWithStore } from "../../common/RenderWithStore.js"

afterEach(() => RenderWithStore.cleanup())

describe("EditorTabs", () => {
  it("opens and closes query tabs", () => {
    const { workbench } = RenderWithStore.render(<EditorTabs />)
    fireEvent.click(screen.getByLabelText("New query tab"))
    expect(workbench.store.getState().workspace.tabs.map(tab => tab.title)).toEqual(["Query 1", "Query 2"])
    fireEvent.click(screen.getByLabelText("Close Query 2"))
    expect(workbench.store.getState().workspace.tabs).toHaveLength(1)
    fireEvent.click(screen.getByTestId("editor-tab-editor-1"))
    expect(workbench.store.getState().workspace.activeTabId).toBe("editor-1")
  })
})

describe("QueryEditor", () => {
  it("registers the wirequery language before mounting and binds edits to the tab", () => {
    const { workbench } = RenderWithStore.render(<QueryEditor />)
    expect(monacoMock.languages.registered.map(language => language.id)).toContain(WireQueryLanguage.Id)
    fireEvent.change(screen.getByTestId(`monaco-${WireQueryLanguage.Id}`), { target: { value: "SELECT 1" } })
    expect(selectActiveEditorTab(workbench.store.getState().workspace).text).toBe("SELECT 1")
  })

  it("Ctrl/Cmd+Enter runs the query; Shift+Alt+F formats", async () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(ConnectionsActions.profilesLoaded(FakeWorkbench.profilesOf("local")))
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    workbench.bridge.answers[IPCChannel.historyList] = []
    RenderWithStore.render(<QueryEditor />, workbench)
    fireEvent.change(screen.getByTestId(`monaco-${WireQueryLanguage.Id}`), {
      target: { value: "select name from sample.positions" }
    })
    const editor = mountedEditors.at(-1),
      run = editor.commands.find(({ keybinding }) => keybinding === (monacoMock.KeyMod.CtrlCmd | monacoMock.KeyCode.Enter)),
      format = editor.commands.find(
        ({ keybinding }) => keybinding === (monacoMock.KeyMod.Shift | monacoMock.KeyMod.Alt | monacoMock.KeyCode.KeyF)
      )
    expect(editor.commands).toHaveLength(3)
    run.handler()
    await waitFor(() => expect(workbench.queryPort.execute).toHaveBeenCalled())
    format.handler()
    await waitFor(() => expect(selectActiveEditorTab(workbench.store.getState().workspace).text).toMatch(/^SELECT name/))
  })
})

describe("QueryEditor chords and options", () => {
  it("binds Run, Run Selection and Format, each to a thunk; options extend the shared base", () => {
    expect(QueryEditor.ChordActions).toEqual([AppAction.run, AppAction.runSelection, AppAction.formatQuery])
    QueryEditor.ChordActions.forEach(action => expect(typeof QueryEditor.ChordThunks[action]()).toBe("function"))
    expect(QueryEditor.Options).toMatchObject({ ...MonacoOptions.base, renderLineHighlight: "line", wordBasedSuggestions: "off" })
    expect(QueryEditor.Options[WireQueryLanguage.SemanticHighlightingOption]).toBe(true)
  })
})
