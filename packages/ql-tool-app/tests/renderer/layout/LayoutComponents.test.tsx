/**
 * @jest-environment jsdom
 */
import { fireEvent, screen } from "@testing-library/react"

import { QueryFailureKind } from "@wireio/ql-shared"

import { SplitDirection, SplitPane, StatusBar, Toolbar, WorkbenchLayout } from "@wireio/ql-tool-app/renderer/layout"
import { QueryPortStatus } from "@wireio/ql-tool-app/renderer/query"
import { ConnectionsActions, UiActions, UiSurface } from "@wireio/ql-tool-app/renderer/store"

import { ExecutionFixtures } from "../../common/ExecutionFixtures.js"
import { FakeQueryPort } from "../../common/FakeQueryPort.js"
import { ConnectionFixtures } from "../../common/ConnectionFixtures.js"
import { FakeWorkbench } from "../../common/FakeWorkbench.js"
import { RenderWithStore } from "../../common/RenderWithStore.js"

afterEach(() => RenderWithStore.cleanup())

describe("Toolbar.canRetry", () => {
  it("transport failures always; engine failures only when the server says retryable", () => {
    expect(Toolbar.canRetry(ExecutionFixtures.failure("a", QueryFailureKind.transport).failure)).toBe(true)
    expect(Toolbar.canRetry(ExecutionFixtures.failure("b", QueryFailureKind.engine, true).failure)).toBe(true)
    expect(Toolbar.canRetry(ExecutionFixtures.failure("c", QueryFailureKind.engine, false).failure)).toBe(false)
    expect(Toolbar.canRetry(ExecutionFixtures.failure("d", QueryFailureKind.cancelled).failure)).toBe(false)
    expect(Toolbar.canRetry(null)).toBe(false)
  })
})

describe("Toolbar", () => {
  it("Run is disabled without a connection; Connections opens the manager", () => {
    const { workbench } = RenderWithStore.render(<Toolbar />)
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Connections" }))
    expect(workbench.store.getState().ui.open).toEqual([UiSurface.connections])
  })

  it("Run is disabled while the query host failed; Export enables after a success", async () => {
    const workbench = await RenderWithStore.withResult()
    RenderWithStore.render(<Toolbar />, workbench)
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Offset"), { target: { value: "5" } })
    expect(workbench.store.getState().ui.windowFields.offset).toBe("5")
  })

  it("a failed host disables Run", () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(ConnectionsActions.profilesLoaded(FakeWorkbench.profilesOf("local")))
    workbench.store.dispatch(ConnectionsActions.portStatusChanged(QueryPortStatus.failed))
    RenderWithStore.render(<Toolbar />, workbench)
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
  })
})

describe("StatusBar", () => {
  it("failed host → Restart calls the query port", () => {
    const workbench = FakeWorkbench.create(),
      port = FakeQueryPort.create()
    workbench.store.dispatch(ConnectionsActions.portStatusChanged(QueryPortStatus.failed))
    RenderWithStore.render(<StatusBar queryPort={FakeQueryPort.asClient(port)} />, workbench)
    expect(screen.getByTestId("host-failed")).toHaveTextContent(StatusBar.HostFailedText)
    fireEvent.click(screen.getByText(StatusBar.RestartLabel))
    expect(port.restart).toHaveBeenCalled()
  })

  it("connected with a result shows endpoint and the outcome", async () => {
    const workbench = await RenderWithStore.withResult()
    workbench.store.dispatch(ConnectionsActions.portStatusChanged(QueryPortStatus.connected))
    RenderWithStore.render(<StatusBar queryPort={FakeQueryPort.asClient(FakeQueryPort.create())} />, workbench)
    expect(screen.getByTestId("status-bar")).toHaveTextContent(`local · ${ConnectionFixtures.Endpoint}`)
    expect(screen.getByTestId("status-outcome")).toHaveTextContent("3 rows")
  })

  it("outcomeOf joins rows with the shared server / wall time parts", () => {
    expect(StatusBar.outcomeOf(ExecutionFixtures.success("r"))).toMatch(/^3 rows · 1200 µs server · \d+\.\d ms wall$/)
  })
})

describe("SplitPane", () => {
  it("renders both panes around an oriented separator", () => {
    RenderWithStore.render(
      <SplitPane direction={SplitDirection.column} initialSize={200} first={<span>top</span>} second={<span>bottom</span>} testId="split" />
    )
    expect(screen.getByTestId("split")).toHaveTextContent("topbottom")
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "horizontal")
  })

  it("a row split has a vertical divider", () => {
    RenderWithStore.render(<SplitPane direction={SplitDirection.row} initialSize={100} first="a" second="b" />)
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical")
  })
})

describe("WorkbenchLayout", () => {
  it("composes toolbar, navigator, editor, results and status bar; shows notices", () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(UiActions.noticeChanged("Exported 3 rows"))
    RenderWithStore.render(<WorkbenchLayout queryPort={FakeQueryPort.asClient(FakeQueryPort.create())} />, workbench)
    expect(screen.getByTestId("query-editor")).toBeInTheDocument()
    expect(screen.getByTestId("status-bar")).toBeInTheDocument()
    expect(screen.getByText("Add a connection to browse the schema.")).toBeInTheDocument()
    expect(screen.getByText("Exported 3 rows")).toBeInTheDocument()
  })
})
