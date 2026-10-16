import { EventEmitter } from "node:events"

import { render } from "ink"

import { ProcessSignalName } from "@wireio/cluster-tool-shared"
import { Deferred, getLoggingManager } from "@wireio/shared"

import { QLExitCode, QLUsageError } from "@wireio/ql-tool-cli/cli/index.js"
import { createTuiServiceRegistry, QueryService, RunTui, runTui, TuiServiceId, TuiServiceRegistry } from "@wireio/ql-tool-cli/tui/index.js"

import { captureLogs } from "../common/logCapture.js"
import { useStubEngine } from "../common/stubEngine.js"
import { createTemporaryDirectory } from "../common/temporaryDirectory.js"
import { createTestContext } from "../common/testContext.js"
import { waitFor } from "../common/waitFor.js"

/** An Ink instance whose exit waits for `unmount` (the mock's resolves at once). */
function pendingInstance() {
  const exited = new Deferred<void>()
  return { unmount: jest.fn(() => exited.resolve()), rerender: jest.fn(), clear: jest.fn(), cleanup: jest.fn(), waitUntilExit: () => exited.promise }
}

describe("runTui", () => {
  const engine = useStubEngine(),
    logging = () => ({ logsPath: createTemporaryDirectory("wql-run-tui-") }),
    connection = () => ({ url: engine().endpoint, owners: ["sample"] })

  it("refuses a non-interactive stdout", async () => {
    await expect(runTui({ context: createTestContext().context, connection: {}, interactive: false })).rejects.toBeInstanceOf(QLUsageError)
  })

  it("boots: file logging, services, editor prefill, Ink with exitOnCtrlC false; restores logging at exit", async () => {
    const before = [...getLoggingManager().appenders],
      code = await runTui({ context: createTestContext().context, connection: connection(), query: "SELECT 5", logging: logging(), interactive: true }),
      [element, options] = (render as jest.Mock).mock.calls.at(-1)
    expect(code).toBe(QLExitCode.success)
    expect(options).toEqual({ exitOnCtrlC: false })
    expect(element.props.store.getState().editor.buffer.text).toBe("SELECT 5")
    expect(getLoggingManager().appenders).toEqual(before)
  })

  it("a boot failure restores stream logging, prints the error and exits non-zero", async () => {
    const logs = captureLogs()
    try {
      const code = await runTui({ context: createTestContext().context, connection: {}, logging: logging(), interactive: true })
      expect(code).toBe(QLExitCode.usage)
      expect(logs.stderr()[0]).toMatch(/no connection/)
    } finally {
      logs.restore()
    }
  })

  it("a rejected Ink exit still stops the services and restores logging, then fails with 1", async () => {
    const before = [...getLoggingManager().appenders],
      stopAll = jest.spyOn(TuiServiceRegistry.prototype, "stopAll"),
      logs = captureLogs()
    ;(render as jest.Mock).mockReturnValueOnce({ ...pendingInstance(), waitUntilExit: () => Promise.reject(new Error("ink crashed")) })
    try {
      const code = await runTui({ context: createTestContext().context, connection: connection(), logging: logging(), interactive: true })
      expect(code).toBe(QLExitCode.failure)
      expect(logs.stderr()).toEqual(["error: ink crashed"])
      expect(stopAll).toHaveBeenCalled()
    } finally {
      logs.restore()
      stopAll.mockRestore()
    }
    expect(getLoggingManager().appenders).toEqual(before)
  })

  it("quits on SIGTERM and SIGHUP (the typed signal names)", () => {
    expect(RunTui.ShutdownSignals).toEqual([ProcessSignalName.SIGTERM, ProcessSignalName.SIGHUP])
  })

  it.each(RunTui.ShutdownSignals)("%s quits like Ctrl+C: the query is cancelled, Ink unmounts, logging returns", async signal => {
    const signals = new EventEmitter(),
      instance = pendingInstance(),
      cancel = jest.spyOn(QueryService.prototype, "cancel"),
      before = [...getLoggingManager().appenders]
    ;(render as jest.Mock).mockReturnValueOnce(instance)
    try {
      const running = runTui({ context: createTestContext().context, connection: connection(), logging: logging(), interactive: true, signals })
      await waitFor(() => signals.listenerCount(signal) > 0)
      signals.emit(signal, signal)
      expect(await running).toBe(QLExitCode.success)
      expect(cancel).toHaveBeenCalled()
      expect(instance.unmount).toHaveBeenCalled()
      expect(RunTui.ShutdownSignals.map(name => signals.listenerCount(name))).toEqual([0, 0])
      expect(getLoggingManager().appenders).toEqual(before)
    } finally {
      cancel.mockRestore()
    }
  })

  it("shutdown reports a failed stop instead of throwing", async () => {
    const registry = createTuiServiceRegistry(createTestContext().context)
    jest.spyOn(registry, "stopAll").mockRejectedValueOnce(new Error("watcher stuck"))
    expect((await RunTui.shutdown(registry, null)).message).toBe("watcher stuck")
    expect(await RunTui.shutdown(registry, null)).toBeNull()
  })

  it("registers the services in dependency order", () => {
    expect(createTuiServiceRegistry(createTestContext().context).order).toEqual([
      TuiServiceId.store,
      TuiServiceId.persistence,
      TuiServiceId.catalog,
      TuiServiceId.query
    ])
  })
})
