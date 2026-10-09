import { TuiRoute, TuiRouter } from "@wireio/ql-tool-cli/tui/index.js"

describe("TuiRouter", () => {
  it("is an immutable stack: push / pop / replace return new routers", () => {
    const root = new TuiRouter(),
      pushed = root.push(TuiRoute.history),
      replaced = pushed.replace(TuiRoute.saved)
    expect(root.current).toBe(TuiRoute.workbench)
    expect(pushed.stack).toEqual([TuiRoute.workbench, TuiRoute.history])
    expect(replaced.stack).toEqual([TuiRoute.workbench, TuiRoute.saved])
    expect(replaced.pop().current).toBe(TuiRoute.workbench)
    expect(root.stack).toEqual([TuiRoute.workbench])
  })

  it("pop on a single-entry stack is a no-op; unknown routes and empty stacks throw", () => {
    const root = new TuiRouter()
    expect(root.pop()).toBe(root)
    expect(() => root.push("nowhere" as TuiRoute)).toThrow(/unknown TUI route/)
    expect(() => new TuiRouter([])).toThrow(/at least one route/)
    Object.entries(TuiRoute).forEach(([name, value]) => expect(value).toBe(name))
  })
})
