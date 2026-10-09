/**
 * @jest-environment jsdom
 */
import { fireEvent, screen } from "@testing-library/react"

import { QueryDrawer, QueryListItem } from "@wireio/ql-tool-app/renderer/components"
import { UiActions, UiSurface } from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../../common/FakeWorkbench.js"
import { RenderWithStore } from "../../../common/RenderWithStore.js"

afterEach(() => RenderWithStore.cleanup())

describe("QueryDrawer", () => {
  it("shows its title, actions, toolbar and items while its surface is open; Close closes it", () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.saved))
    RenderWithStore.render(
      <QueryDrawer surface={UiSurface.saved} title="Saved" listTestId="list" actions={<button>extra</button>} toolbar={<span>bar</span>}>
        <li>item</li>
      </QueryDrawer>,
      workbench
    )
    expect(screen.getByText("Saved")).toBeVisible()
    expect(screen.getByText("extra")).toBeVisible()
    expect(screen.getByText("bar")).toBeVisible()
    expect(screen.getByTestId("list")).toHaveTextContent("item")
    fireEvent.click(screen.getByText(QueryDrawer.CloseLabel))
    expect(workbench.store.getState().ui.open).toEqual([])
  })

  it("stays hidden while its surface is closed", () => {
    RenderWithStore.render(
      <QueryDrawer surface={UiSurface.history} title="History" listTestId="list">
        <li>item</li>
      </QueryDrawer>
    )
    expect(screen.queryByText("History")).not.toBeVisible()
  })
})

describe("QueryListItem", () => {
  it("click opens; Re-run and Delete run their own action only (named after the identity)", () => {
    const onOpen = jest.fn(),
      onRerun = jest.fn(),
      onDelete = jest.fn()
    RenderWithStore.render(
      <QueryListItem primary="SELECT 1" secondary="detail" primaryIsQuery identity="h1" onOpen={onOpen} onRerun={onRerun} onDelete={onDelete} />
    )
    fireEvent.click(screen.getByRole("button", { name: `${QueryDrawer.RerunLabel} h1` }))
    fireEvent.click(screen.getByRole("button", { name: `${QueryDrawer.DeleteLabel} h1` }))
    expect(onRerun).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("SELECT 1"))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("has no Delete button without onDelete", () => {
    RenderWithStore.render(<QueryListItem primary="p" secondary="s" identity="x" onOpen={jest.fn()} onRerun={jest.fn()} />)
    expect(screen.queryByRole("button", { name: `${QueryDrawer.DeleteLabel} x` })).toBeNull()
  })
})
