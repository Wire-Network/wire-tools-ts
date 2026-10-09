/**
 * @jest-environment jsdom
 */
import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { Provider } from "react-redux"

import { UiActions, UiSurface, useSurface } from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../common/FakeWorkbench.js"

/** Props of the store wrapper. */
interface WrapperProps {
  children: ReactNode
}

describe("useSurface", () => {
  it("follows whether the surface is open", () => {
    const workbench = FakeWorkbench.create(),
      wrapper = ({ children }: WrapperProps) => <Provider store={workbench.store}>{children}</Provider>,
      { result } = renderHook(() => useSurface(UiSurface.export), { wrapper })
    expect(result.current).toBe(false)
    act(() => {
      workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.export))
    })
    expect(result.current).toBe(true)
    act(() => {
      workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.history))
      workbench.store.dispatch(UiActions.surfaceClosed(UiSurface.export))
    })
    expect(result.current).toBe(false)
  })
})
