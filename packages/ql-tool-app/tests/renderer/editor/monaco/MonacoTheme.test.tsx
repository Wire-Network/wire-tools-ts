/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { useMonacoTheme, WireQueryLanguage } from "@wireio/ql-tool-app/renderer/editor/monaco"

/**
 * Install a matchMedia answering `dark` for the dark-scheme query.
 *
 * @param dark - Whether the OS scheme is dark.
 */
function prefersDark(dark: boolean): void {
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: dark,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn()
    })
  })
}

describe("useMonacoTheme", () => {
  it("is the wirequery theme of the OS color scheme", () => {
    prefersDark(true)
    expect(renderHook(() => useMonacoTheme()).result.current).toBe(WireQueryLanguage.DarkTheme)
    prefersDark(false)
    expect(renderHook(() => useMonacoTheme()).result.current).toBe(WireQueryLanguage.LightTheme)
  })
})
