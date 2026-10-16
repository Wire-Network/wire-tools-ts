import type { ReactElement, ReactNode } from "react"
import { ThemeProvider } from "@mui/material/styles"
import { render, type RenderOptions, type RenderResult } from "@testing-library/react"
import { Provider } from "react-redux"

import { QLBridge } from "@wireio/ql-tool-app/common"
import { createQLTheme } from "@wireio/ql-tool-app/renderer/theme"
import { ConnectionsActions, WorkspaceActions, runQuery } from "@wireio/ql-tool-app/renderer/store"

import { ExecutionFixtures } from "./ExecutionFixtures.js"
import { FakeWorkbench } from "./FakeWorkbench.js"

/** Component-test rendering over a fake workbench (jsdom suites only). */
export namespace RenderWithStore {
  /** A render result plus the workbench it rendered over. */
  export interface Rendered extends RenderResult {
    /** The workbench rendered over. */
    workbench: FakeWorkbench
  }

  /** Props of the provider wrapper (kept across `rerender`). */
  export interface WrapperProps {
    /** The rendered element. */
    children: ReactNode
  }

  /**
   * Render `element` inside the store + theme providers.
   *
   * @param element - The component under test.
   * @param workbench - The fake workbench (default: a new one).
   * @returns The render result and the workbench.
   */
  export function render(
    element: ReactElement,
    workbench: FakeWorkbench = FakeWorkbench.create()
  ): RenderWithStore.Rendered {
    Object.assign(window, { [QLBridge.Key]: workbench.bridge })
    const theme = createQLTheme(),
      wrapper = ({ children }: RenderWithStore.WrapperProps) => (
        <Provider store={workbench.store}>
          <ThemeProvider theme={theme}>{children}</ThemeProvider>
        </Provider>
      )
    const options: RenderOptions = { wrapper }
    return { ...renderElement(element, options), workbench }
  }

  /**
   * A workbench whose focused result holds `execution` (default: the positions page).
   *
   * @param resolve - Builds the execution for the request id.
   * @returns The workbench.
   */
  export async function withResult(
    resolve: (requestId: string) => ReturnType<typeof ExecutionFixtures.asExecution> = requestId =>
      ExecutionFixtures.success(requestId)
  ): Promise<FakeWorkbench> {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(ConnectionsActions.profilesLoaded(FakeWorkbench.profilesOf("local")))
    workbench.store.dispatch(WorkspaceActions.textChanged({ id: "editor-1", text: ExecutionFixtures.PositionsQuery }))
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => resolve(requestId))
    await workbench.store.dispatch(runQuery(false))
    return workbench
  }

  /** Remove the fake bridge from window. */
  export function cleanup(): void {
    delete (window as unknown as Record<string, unknown>)[QLBridge.Key]
  }
}

const renderElement = render
