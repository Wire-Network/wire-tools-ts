import {
  FocusArea,
  initialUiState,
  MessageLevel,
  PromptKind,
  ResultsTab,
  TuiModal,
  UiActions,
  UiSlice,
  UiState
} from "@wireio/ql-tool-cli/tui/index.js"

const reduce = UiSlice.reducer

describe("UiSlice", () => {
  it("cycles focus both ways (wrapping) and sets it", () => {
    expect(reduce(initialUiState, UiActions.focusedNext()).focus).toBe(FocusArea.grid)
    expect(reduce(initialUiState, UiActions.focusedPrevious()).focus).toBe(FocusArea.schema)
    expect(UiState.cycleFocus(FocusArea.grid, 1)).toBe(FocusArea.schema)
    expect(reduce(initialUiState, UiActions.focusSet(FocusArea.grid)).focus).toBe(FocusArea.grid)
  })

  it("toggles JSON / record tabs and selects tabs", () => {
    const json = reduce(initialUiState, UiActions.jsonToggled())
    expect(json.tab).toBe(ResultsTab.json)
    expect(reduce(json, UiActions.jsonToggled()).tab).toBe(ResultsTab.grid)
    expect(reduce(json, UiActions.recordViewToggled()).tab).toBe(ResultsTab.record)
    expect(reduce(reduce(json, UiActions.recordViewToggled()), UiActions.recordViewToggled()).tab).toBe(ResultsTab.grid)
    expect(reduce(initialUiState, UiActions.tabSelected(ResultsTab.stats)).tab).toBe(ResultsTab.stats)
  })

  it("opens/closes modals and prompts", () => {
    const prompt = { kind: PromptKind.saveQuery, title: "t", initial: "" },
      opened = reduce(initialUiState, UiActions.promptOpened(prompt))
    expect(opened).toMatchObject({ modal: TuiModal.prompt, prompt })
    expect(reduce(opened, UiActions.modalOpened(TuiModal.find))).toMatchObject({ modal: TuiModal.find, prompt: null })
    expect(reduce(opened, UiActions.modalClosed())).toMatchObject({ modal: TuiModal.none, prompt: null })
  })

  it("keeps a bounded message list", () => {
    const many = Array.from({ length: UiState.MaxMessages + 5 }).reduce<typeof initialUiState>(
      state => reduce(state, UiActions.message(MessageLevel.info, "m")),
      initialUiState
    )
    expect(many.messages).toHaveLength(UiState.MaxMessages)
  })

  it("message stamps the time when the action is created", () => {
    const before = Date.now(),
      action = UiActions.message(MessageLevel.warn, "careful")
    expect(action.payload).toMatchObject({ level: MessageLevel.warn, text: "careful" })
    expect(Date.parse(action.payload.at)).toBeGreaterThanOrEqual(before - 1)
    expect(reduce(initialUiState, action).messages).toEqual([action.payload])
  })
})
