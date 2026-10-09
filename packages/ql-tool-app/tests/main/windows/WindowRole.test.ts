import { WindowRole } from "@wireio/ql-tool-app/main/windows"

describe("WindowRole", () => {
  it("is an identity enum with the workbench role", () => {
    expect(Object.entries(WindowRole)).toEqual([["workbench", "workbench"]])
  })
})
