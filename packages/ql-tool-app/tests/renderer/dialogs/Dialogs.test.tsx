/**
 * @jest-environment jsdom
 */
import { fireEvent, screen, waitFor } from "@testing-library/react"

import { ConnectionProfileForm, OutputFormat } from "@wireio/ql-shared"

import { DialogOutcome, IPCChannel } from "@wireio/ql-tool-app/common"
import { ConnectionManagerDialog, ExportDialog, SaveQueryDialog } from "@wireio/ql-tool-app/renderer/dialogs"
import { ExportScope, UiActions, UiSurface } from "@wireio/ql-tool-app/renderer/store"

import { ConnectionFixtures } from "../../common/ConnectionFixtures.js"
import { FakeWorkbench } from "../../common/FakeWorkbench.js"
import { RenderWithStore } from "../../common/RenderWithStore.js"

afterEach(() => RenderWithStore.cleanup())

describe("ConnectionProfileForm (the connection manager's form)", () => {
  it("accepts a valid form and rejects a non-http endpoint with a field message", () => {
    const form = { ...ConnectionProfileForm.empty(), name: "local", endpoint: ConnectionFixtures.Endpoint, owners: "a, b" }
    expect(ConnectionProfileForm.toProfile(form).getOrThrow()).toMatchObject({ name: "local", owners: ["a", "b"] })
    const invalid = ConnectionProfileForm.toProfile({ ...form, endpoint: "ftp://x" })
    expect(invalid.isLeft()).toBe(true)
    expect(invalid.getLeftOrThrow()).toMatch(/^endpoint: /)
  })

  it("formOf round-trips a profile", () => {
    const [profile] = FakeWorkbench.profilesOf("local").profiles,
      form = ConnectionProfileForm.of({ ...profile, transportTimeoutMs: 5_000 })
    expect(form).toMatchObject({ name: "local", transportTimeoutMs: "5000", queryTimeoutMs: "", owners: "sample" })
  })
})

describe("ConnectionManagerDialog", () => {
  it("saves a new connection through profilesUpsert", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.profilesUpsert] = FakeWorkbench.profilesOf("local")
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.connections))
    RenderWithStore.render(<ConnectionManagerDialog />, workbench)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "local" } })
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: ConnectionFixtures.Endpoint } })
    fireEvent.click(screen.getByText("Save"))
    await waitFor(() => expect(screen.getByTestId("connection-message")).toHaveTextContent("Saved local"))
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.profilesUpsert)).toEqual([
      expect.objectContaining({ name: "local", endpoint: ConnectionFixtures.Endpoint })
    ])
  })

  it("an invalid form shows the validation message and saves nothing", () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.connections))
    RenderWithStore.render(<ConnectionManagerDialog />, workbench)
    fireEvent.click(screen.getByText("Save"))
    expect(screen.getByTestId("connection-message")).toHaveTextContent("name:")
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.profilesUpsert)).toEqual([])
  })
})

describe("ExportDialog", () => {
  it("defaults to CSV / this page / header and starts an export", async () => {
    expect(ExportDialog.defaultOptions()).toEqual({ format: OutputFormat.csv, scope: ExportScope.page, header: true })
    const workbench = await RenderWithStore.withResult()
    workbench.bridge.answers[IPCChannel.showSaveDialog] = { outcome: DialogOutcome.cancelled }
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.export))
    RenderWithStore.render(<ExportDialog />, workbench)
    fireEvent.click(screen.getByText("Export…"))
    await waitFor(() => expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.showSaveDialog)).toHaveLength(1))
    expect(workbench.store.getState().ui.open).not.toContain(UiSurface.export)
  })

  it("Cancel closes without exporting", () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.export))
    RenderWithStore.render(<ExportDialog />, workbench)
    fireEvent.click(screen.getByText("Cancel"))
    expect(workbench.store.getState().ui.open).toEqual([])
    expect(workbench.bridge.invoke).not.toHaveBeenCalled()
  })
})

describe("SaveQueryDialog", () => {
  it("Save is disabled for a blank name and saves under the trimmed name", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.savedUpsert] = []
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.saveQuery))
    RenderWithStore.render(<SaveQueryDialog />, workbench)
    expect(screen.getByText("Save")).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  daily  " } })
    fireEvent.click(screen.getByText("Save"))
    await waitFor(() =>
      expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.savedUpsert)).toEqual([{ name: "daily", query: "" }])
    )
  })
})
