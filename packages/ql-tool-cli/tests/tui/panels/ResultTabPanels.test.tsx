import { QueryErrorKind } from "@wireio/ql-shared"

import {
  createTuiStore,
  FieldTypesPanel,
  MessageLevel,
  MessagesPanel,
  RecordViewPanel,
  ResultsActions,
  ResultsJsonPanel,
  StatePanel,
  StatsPanel,
  UiActions
} from "@wireio/ql-tool-cli/tui/index.js"

import { engineFailureExecution } from "../../common/engineFixtures.js"
import { renderTui, textOf } from "../../common/renderTui.js"
import { storeWithResult } from "../../common/storeFixtures.js"

describe("result tab panels", () => {
  it("JSON renders the loaded page through the shared renderer, windowed", () => {
    const text = textOf(renderTui(<ResultsJsonPanel height={4} />, { store: storeWithResult() }))
    expect(text).toBe('[\n  {\n    "id": "1",\n    "name": "alice"')
    expect(textOf(renderTui(<ResultsJsonPanel height={4} />, { store: createTuiStore() }))).toBe(ResultsJsonPanel.EmptyText)
  })

  it("JSON scrolls by its own line offset, independent of the grid cursor", () => {
    const store = storeWithResult()
    store.dispatch(ResultsActions.cursorPlaced(2))
    store.dispatch(ResultsActions.jsonScrolled({ delta: 2, lineCount: 50, height: 2 }))
    expect(textOf(renderTui(<ResultsJsonPanel height={2} />, { store }))).toBe('    "id": "1",\n    "name": "alice"')
  })

  it("Record shows the cursor row column by column", () => {
    const store = storeWithResult()
    store.dispatch(ResultsActions.cursorPlaced(2))
    expect(textOf(renderTui(<RecordViewPanel />, { store }))).toBe("record 3 of 3\nid: 3\nname: carol")
    store.dispatch(ResultsActions.cursorPlaced(99))
    expect(textOf(renderTui(<RecordViewPanel />, { store }))).toContain("record 3 of 3")
    expect(textOf(renderTui(<RecordViewPanel />, { store: createTuiStore() }))).toBe(RecordViewPanel.EmptyText)
  })

  it("Field Types lists columns[]", () => {
    expect(textOf(renderTui(<FieldTypesPanel />, { store: storeWithResult() }))).toBe(
      "name  logical_type  abi_type  nullable  encoding\nid  integer  -  true  decimal_string\nname  text  -  true  text"
    )
    expect(textOf(renderTui(<FieldTypesPanel />, { store: createTuiStore() }))).toBe(FieldTypesPanel.EmptyText)
  })

  it("Stats and State show the page, counters and snapshot", () => {
    expect(textOf(renderTui(<StatsPanel />, { store: storeWithResult() }))).toContain("page: offset 0 · limit none · returned 3 · total 3")
    expect(textOf(renderTui(<StatePanel />, { store: storeWithResult() }))).toContain("block 42 ")
    expect(textOf(renderTui(<StatsPanel />, { store: storeWithResult(engineFailureExecution(QueryErrorKind.QUERY_LIMIT)) }))).toBe(StatsPanel.EmptyText)
    expect(textOf(renderTui(<StatePanel />, { store: createTuiStore() }))).toBe(StatePanel.EmptyText)
  })

  it("Messages lists the newest messages with level colors", () => {
    const store = createTuiStore()
    expect(textOf(renderTui(<MessagesPanel height={3} />, { store }))).toBe(MessagesPanel.EmptyText)
    store.dispatch({ type: UiActions.message.type, payload: { level: MessageLevel.error, text: "bad", at: "2026-10-07T12:34:56.000Z" } })
    expect(textOf(renderTui(<MessagesPanel height={3} />, { store }))).toBe("12:34:56 bad")
    expect([MessagesPanel.colorOf(MessageLevel.info), MessagesPanel.colorOf(MessageLevel.warn), MessagesPanel.colorOf(MessageLevel.error)]).toEqual([undefined, "yellow", "red"])
  })
})
