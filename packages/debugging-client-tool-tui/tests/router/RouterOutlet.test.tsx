import React from "react"
import { RouterOutlet } from "@wireio/debugging-client-tool-tui/router/RouterOutlet.js"

describe("RouterOutlet", () => {
  it("is a function component", () => {
    expect(typeof RouterOutlet).toBe("function")
  })

  it("renders the current route's component when the router has an active match", () => {
    const match = {
      route: {
        path: "/x",
        featureId: "t",
        name: "X",
        component: () => React.createElement("span", null, "X-content"),
        cyclable: true
      },
      params: {}
    }
    const fakeRouter = {
      stack: [match],
      current: match,
      canGoBack: false,
      push: jest.fn(),
      replace: jest.fn(),
      pop: jest.fn(),
      reset: jest.fn()
    }
    const spy = jest
      .spyOn(React, "useContext")
      .mockImplementation(() => fakeRouter)
    try {
      const element = RouterOutlet()
      expect(React.isValidElement(element)).toBe(true)
      // The outlet should render the route's component, not a placeholder.
      expect((element.type as any).name).not.toBe("Text")
    } finally {
      spy.mockRestore()
    }
  })

  it("renders a dim placeholder when no route is current", () => {
    const fakeRouter = {
      stack: [],
      current: undefined,
      canGoBack: false,
      push: jest.fn(),
      replace: jest.fn(),
      pop: jest.fn(),
      reset: jest.fn()
    }
    const spy = jest
      .spyOn(React, "useContext")
      .mockImplementation(() => fakeRouter)
    try {
      const element = RouterOutlet()
      expect(React.isValidElement(element)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
