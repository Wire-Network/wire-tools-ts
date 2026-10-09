import { getLoggingManager, Level, type LogRecord } from "@wireio/shared"

import { guarded, GuardedReport, type AppThunk } from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../../../common/FakeWorkbench.js"

describe("guarded", () => {
  const manager = getLoggingManager(),
    previous = [...manager.appenders],
    records: LogRecord[] = []

  beforeAll(() => {
    manager.setAppenders({ append: (record: LogRecord) => records.push(record) } as never)
  })

  afterAll(() => {
    manager.setAppenders(previous)
  })

  it("runs the operation with the store's dispatch, getState and services", async () => {
    const workbench = FakeWorkbench.create(),
      operation = jest.fn(async () => undefined) as unknown as AppThunk
    await workbench.store.dispatch(guarded("Probing", operation))
    expect(operation).toHaveBeenCalledWith(expect.any(Function), workbench.store.getState, workbench.services)
    expect(workbench.store.getState().ui.notice).toBeNull()
  })

  it("a failure is logged with the error and becomes a notice (default reporter), never a rejection", async () => {
    const workbench = FakeWorkbench.create(),
      failure = new Error("EACCES")
    await expect(
      workbench.store.dispatch(
        guarded("Probing", async () => {
          throw failure
        })
      )
    ).resolves.toBeUndefined()
    expect(workbench.store.getState().ui.notice).toBe("Probing failed: EACCES")
    const logged = records.find(record => String(record.message) === "Probing failed: EACCES")
    expect(logged.level).toBe(Level.warn)
    expect(logged.args[0]).toBe(failure)
  })

  it("a custom reporter receives label, message and error; logOnly shows nothing", async () => {
    const workbench = FakeWorkbench.create(),
      report = jest.fn(),
      failure = new Error("gone")
    await workbench.store.dispatch(
      guarded(
        "Loading",
        async () => {
          throw failure
        },
        report
      )
    )
    expect(report).toHaveBeenCalledWith(expect.any(Function), { label: "Loading", message: "gone", error: failure })
    await workbench.store.dispatch(
      guarded(
        "Quiet",
        async () => {
          throw failure
        },
        GuardedReport.logOnly
      )
    )
    expect(workbench.store.getState().ui.notice).toBeNull()
  })
})
