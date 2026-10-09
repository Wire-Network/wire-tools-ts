import type { Key } from "ink"

import { OutputFormat } from "@wireio/ql-shared"

import { ExportModal, ExportScope, QueryService, TuiAction, TuiServiceId } from "@wireio/ql-tool-cli/tui/index.js"

import { key } from "../../common/inkKeys.js"
import { press, renderTui, settle, textOf } from "../../common/renderTui.js"
import { useStubEngine } from "../../common/stubEngine.js"
import { startTuiHarness, type TuiHarness } from "../../common/tuiHarness.js"

describe("ExportModal", () => {
  let harness: TuiHarness

  const engine = useStubEngine()

  beforeEach(async () => {
    harness = await startTuiHarness(engine().endpoint)
  })

  afterEach(() => harness.registry.stopAll())

  it("cycles format (renaming the file), toggles scope and header, and exports on Enter", async () => {
    const exportResult = jest.spyOn(harness.registry.get<QueryService>(TuiServiceId.query), "exportResult").mockResolvedValue("/x"),
      renderer = renderTui(<ExportModal />, { store: harness.store, registry: harness.registry })
    expect(textOf(renderer)).toContain("format csv · scope page · header on\nwql-export.csv")
    press("", { tab: true })
    press("t", { ctrl: true })
    press("e", { ctrl: true })
    expect(textOf(renderer)).toContain("format tsv · scope all · header off\nwql-export.tsv")
    press("", { return: true })
    await settle()
    expect(exportResult).toHaveBeenCalledWith({ format: OutputFormat.tsv, scope: ExportScope.all, header: false, file: "wql-export.tsv" })
  })

  it("reports a failed export in Messages; Esc cancels", async () => {
    renderTui(<ExportModal />, { store: harness.store, registry: harness.registry })
    press("", { return: true })
    await settle()
    expect(harness.store.getState().ui.messages.at(-1).text).toMatch(/export failed: .*nothing to export/)
    renderTui(<ExportModal />, { store: harness.store, registry: harness.registry })
    press("", { escape: true })
  })

  it("format math wraps and swaps the extension", () => {
    expect(ExportModal.nextFormat(OutputFormat.raw)).toBe(OutputFormat.table)
    expect(ExportModal.fileName("noext", OutputFormat.json)).toBe("noext.json")
    expect(ExportModal.fileName("out/rows.v1.csv", OutputFormat.markdown)).toBe("out/rows.v1.md")
    expect(ExportModal.choiceText(ExportModal.initialChoice())).toBe("format csv · scope page · header on")
  })

  it("handleChoiceKey consumes only the dialog's own keys", () => {
    const choices: unknown[] = [],
      files: string[] = [],
      choice = ExportModal.initialChoice(),
      handle = (input: string, flags: Partial<Key>) =>
        ExportModal.handleChoiceKey({ action: TuiAction.none, input, key: key(flags) }, choice, next => choices.push(next), text => files.push(text), "a.csv")
    expect(handle("x", {})).toBe(false)
    expect(handle("t", { ctrl: true })).toBe(true)
    expect(handle("", { tab: true })).toBe(true)
    expect(choices).toEqual([{ ...choice, scope: ExportScope.all }, { ...choice, format: OutputFormat.tsv }])
    expect(files).toEqual(["a.tsv"])
  })
})

describe("ExportModal.KeysHint", () => {
  it("spells every key from a chord (Tab, the Ctrl toggles, Enter, Esc)", () => {
    expect(ExportModal.KeysHint).toBe("Tab format · Ctrl+T page/all · Ctrl+E header · Enter export · Esc cancel")
  })
})
