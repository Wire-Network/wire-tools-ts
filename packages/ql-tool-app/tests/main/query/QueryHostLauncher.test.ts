import type { WebContents } from "electron"

import {
  HostControlKind,
  IPCEventChannel,
  QueryHostArguments,
  type HostControlMessage
} from "@wireio/ql-tool-app/common"
import { QueryHostLauncher, QueryHostState } from "@wireio/ql-tool-app/main/query"

import {
  FakeWebContents,
  MessageChannelMain,
  utilityProcess,
  type FakeUtilityProcess
} from "../../__mocks__/electron.js"

/** Test fixture constants. */
namespace Fixture {
  export const HostModuleFile = "/app/query-host.js"
  export const LogsPath = "/app/logs"
  export const ExitCode = 1
}

/**
 * The fake window as the launcher's WebContents parameter type.
 *
 * @param webContents - The fake.
 * @returns The same object, typed for the launcher.
 */
function asWebContents(webContents: FakeWebContents): WebContents {
  return webContents as unknown as WebContents
}

/** A launcher over the fixture paths (not started). */
function newLauncher(): QueryHostLauncher {
  return new QueryHostLauncher({ hostModuleFile: Fixture.HostModuleFile, logsPath: Fixture.LogsPath })
}

/** The most recently forked fake host. */
function lastChild(): FakeUtilityProcess {
  return utilityProcess.forked[utilityProcess.forked.length - 1]
}

/** Control message kinds posted to a child, in order. */
function postedKinds(child: FakeUtilityProcess): HostControlKind[] {
  return child.posted.map(({ message }) => (message as HostControlMessage).kind)
}

/** A launcher whose first host has spawned. */
function readyLauncher(): QueryHostLauncher {
  const launcher = newLauncher()
  launcher.start()
  lastChild().emit("spawn")
  return launcher
}

/**
 * Crash the running host, let the backoff elapse and the respawn spawn.
 *
 * @param launcher - The launcher.
 */
function crashAndRespawn(launcher: QueryHostLauncher): void {
  lastChild().emit("exit", Fixture.ExitCode)
  jest.advanceTimersByTime(QueryHostLauncher.BackoffMaxMs)
  lastChild().emit("spawn")
  expect(launcher.state).toBe(QueryHostState.ready)
}

/** A launcher that crash-looped into `failed`. */
function failedLauncher(): QueryHostLauncher {
  const launcher = readyLauncher()
  Array.from({ length: QueryHostLauncher.MaxRestarts }).forEach(() => crashAndRespawn(launcher))
  lastChild().emit("exit", Fixture.ExitCode)
  expect(launcher.state).toBe(QueryHostState.failed)
  return launcher
}

beforeEach(() => {
  jest.useFakeTimers()
  utilityProcess.forked.length = 0
  utilityProcess.fork.mockClear()
  MessageChannelMain.created.length = 0
})

afterEach(() => {
  jest.useRealTimers()
})

describe("QueryHostLauncher", () => {
  it("starts idle and forks the host with the logs flag + service name", () => {
    const launcher = newLauncher()
    expect(launcher.state).toBe(QueryHostState.idle)
    launcher.start()
    expect(launcher.state).toBe(QueryHostState.spawning)
    expect(utilityProcess.fork).toHaveBeenCalledWith(
      Fixture.HostModuleFile,
      [QueryHostArguments.LogsPathFlag, Fixture.LogsPath],
      { serviceName: QueryHostLauncher.ServiceName }
    )
    expect(launcher.pid).toBe(lastChild().pid)
  })

  it("start is valid only while idle", () => {
    const launcher = readyLauncher()
    expect(() => launcher.start()).toThrow(/cannot start in ready/)
    launcher.dispose()
    expect(() => launcher.start()).toThrow(/cannot start in disposed/)
    expect(utilityProcess.forked).toHaveLength(1)
  })

  it("a port request before start is queued (port2 delivered at once) and served by the first host", () => {
    const launcher = newLauncher(),
      window = new FakeWebContents()
    launcher.portRequested(asWebContents(window))
    expect(launcher.state).toBe(QueryHostState.idle)
    expect(launcher.queuedCount).toBe(1)
    const [channel] = MessageChannelMain.created
    expect(window.postMessage).toHaveBeenCalledWith(IPCEventChannel.queryPort, null, [channel.port2])
    launcher.start()
    lastChild().emit("spawn")
    expect(lastChild().posted).toEqual([
      { message: { kind: HostControlKind.attach, windowId: window.id }, transfer: [channel.port1] }
    ])
  })

  it("windowClosed before start drops the queued attach; restart is a no-op while idle", () => {
    const launcher = newLauncher(),
      window = new FakeWebContents()
    launcher.portRequested(asWebContents(window))
    launcher.windowClosed(window.id)
    launcher.restartRequested()
    expect(launcher.state).toBe(QueryHostState.idle)
    expect(launcher.queuedCount).toBe(0)
    expect(MessageChannelMain.created[0].port1.closed).toBe(true)
    expect(utilityProcess.forked).toHaveLength(0)
  })

  it("a fork that throws synchronously is an exit: the queue is cleared, windows hear queryHostExited, the backoff forks again", () => {
    const launcher = newLauncher(),
      window = new FakeWebContents()
    utilityProcess.fork.mockImplementationOnce(() => {
      throw new Error("EACCES")
    })
    launcher.portRequested(asWebContents(window))
    launcher.start()
    expect(launcher.state).toBe(QueryHostState.backoff)
    expect(window.send).toHaveBeenCalledWith(IPCEventChannel.queryHostExited)
    expect(launcher.queuedCount).toBe(0)
    jest.advanceTimersByTime(QueryHostLauncher.backoffDelayMs(1))
    expect(launcher.state).toBe(QueryHostState.spawning)
    expect(utilityProcess.forked).toHaveLength(1)
  })

  it("queues an attach while spawning and flushes it on spawn (port2 to the window, port1 to the host)", () => {
    const launcher = newLauncher(),
      window = new FakeWebContents()
    launcher.start()
    launcher.portRequested(asWebContents(window))
    expect(launcher.queuedCount).toBe(1)
    const [channel] = MessageChannelMain.created
    expect(window.postMessage).toHaveBeenCalledWith(IPCEventChannel.queryPort, null, [channel.port2])
    expect(lastChild().posted).toHaveLength(0)
    lastChild().emit("spawn")
    expect(launcher.state).toBe(QueryHostState.ready)
    expect(launcher.queuedCount).toBe(0)
    expect(lastChild().posted).toEqual([
      { message: { kind: HostControlKind.attach, windowId: window.id }, transfer: [channel.port1] }
    ])
  })

  it("attaches immediately when ready", () => {
    const launcher = readyLauncher(),
      window = new FakeWebContents()
    launcher.portRequested(asWebContents(window))
    expect(postedKinds(lastChild())).toEqual([HostControlKind.attach])
  })

  it("a reload (second request from an attached window) detaches before attaching", () => {
    const launcher = readyLauncher(),
      window = new FakeWebContents()
    launcher.portRequested(asWebContents(window))
    launcher.portRequested(asWebContents(window))
    expect(postedKinds(lastChild())).toEqual([HostControlKind.attach, HostControlKind.detach, HostControlKind.attach])
    expect(MessageChannelMain.created).toHaveLength(2)
  })

  it("a second request while queued supersedes the first attach and closes its untransferred port1", () => {
    const launcher = newLauncher(),
      window = new FakeWebContents()
    launcher.start()
    launcher.portRequested(asWebContents(window))
    launcher.portRequested(asWebContents(window))
    const [first, second] = MessageChannelMain.created
    expect(first.port1.closed).toBe(true)
    expect(launcher.queuedCount).toBe(1)
    lastChild().emit("spawn")
    expect(lastChild().posted).toEqual([
      { message: { kind: HostControlKind.attach, windowId: window.id }, transfer: [second.port1] }
    ])
  })

  it("an exit backs off, broadcasts queryHostExited to live windows only, then respawns", () => {
    const launcher = readyLauncher(),
      live = new FakeWebContents(),
      destroyed = new FakeWebContents()
    launcher.portRequested(asWebContents(live))
    launcher.portRequested(asWebContents(destroyed))
    destroyed.destroyed = true
    lastChild().emit("exit", Fixture.ExitCode)
    expect(launcher.state).toBe(QueryHostState.backoff)
    expect(live.send).toHaveBeenCalledWith(IPCEventChannel.queryHostExited)
    expect(destroyed.send).not.toHaveBeenCalled()
    jest.advanceTimersByTime(QueryHostLauncher.backoffDelayMs(1) - 1)
    expect(utilityProcess.forked).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(utilityProcess.forked).toHaveLength(2)
    expect(launcher.state).toBe(QueryHostState.spawning)
  })

  it("a request during backoff is queued and attached to the respawned host", () => {
    const launcher = readyLauncher(),
      window = new FakeWebContents()
    lastChild().emit("exit", Fixture.ExitCode)
    launcher.portRequested(asWebContents(window))
    expect(launcher.queuedCount).toBe(1)
    jest.advanceTimersByTime(QueryHostLauncher.BackoffMaxMs)
    lastChild().emit("spawn")
    expect(postedKinds(lastChild())).toEqual([HostControlKind.attach])
  })

  it("an exit clears the queue and closes every queued port1", () => {
    const launcher = newLauncher(),
      window = new FakeWebContents()
    launcher.start()
    launcher.portRequested(asWebContents(window))
    lastChild().emit("exit", Fixture.ExitCode)
    expect(launcher.queuedCount).toBe(0)
    expect(MessageChannelMain.created[0].port1.closed).toBe(true)
  })

  it("a fork error counts as an exit", () => {
    const launcher = readyLauncher()
    lastChild().emit("error", "FatalError", "location")
    expect(launcher.state).toBe(QueryHostState.backoff)
  })

  it("a stale child's events are ignored", () => {
    const launcher = readyLauncher(),
      stale = lastChild()
    crashAndRespawn(launcher)
    stale.emit("exit", Fixture.ExitCode)
    expect(launcher.state).toBe(QueryHostState.ready)
  })

  it("backoff doubles per exit and caps at BackoffMaxMs", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(QueryHostLauncher.backoffDelayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000
    ])
  })

  it("the MaxRestarts-th exit still backs off; one more enters failed and sends only queryHostFailed", () => {
    const launcher = readyLauncher(),
      window = new FakeWebContents()
    launcher.portRequested(asWebContents(window))
    Array.from({ length: QueryHostLauncher.MaxRestarts }).forEach(() => crashAndRespawn(launcher))
    window.send.mockClear()
    lastChild().emit("exit", Fixture.ExitCode)
    expect(launcher.state).toBe(QueryHostState.failed)
    expect(window.send.mock.calls).toEqual([[IPCEventChannel.queryHostFailed]])
    expect(launcher.waitingWindowIds).toEqual([window.id])
    jest.advanceTimersByTime(QueryHostLauncher.RestartIntervalMs)
    expect(utilityProcess.forked).toHaveLength(QueryHostLauncher.MaxRestarts + 1)
  })

  it("exits older than RestartIntervalMs leave the sliding window", () => {
    const launcher = readyLauncher()
    Array.from({ length: QueryHostLauncher.MaxRestarts }).forEach(() => crashAndRespawn(launcher))
    jest.advanceTimersByTime(QueryHostLauncher.RestartIntervalMs)
    lastChild().emit("exit", Fixture.ExitCode)
    expect(launcher.state).toBe(QueryHostState.backoff)
  })

  describe("failed", () => {
    it("a port request creates no channel, records the window waiting and answers queryHostFailed", () => {
      const launcher = failedLauncher(),
        window = new FakeWebContents(),
        channels = MessageChannelMain.created.length
      launcher.portRequested(asWebContents(window))
      expect(MessageChannelMain.created).toHaveLength(channels)
      expect(window.send).toHaveBeenCalledWith(IPCEventChannel.queryHostFailed)
      expect(launcher.waitingWindowIds).toEqual([window.id])
    })

    it("restart forks, resets the crash counter and serves every waiting window", () => {
      const launcher = failedLauncher(),
        first = new FakeWebContents(),
        second = new FakeWebContents()
      launcher.portRequested(asWebContents(first))
      launcher.portRequested(asWebContents(second))
      launcher.restartRequested()
      expect(launcher.state).toBe(QueryHostState.spawning)
      expect(launcher.waitingWindowIds).toEqual([])
      expect(first.postMessage).toHaveBeenCalledWith(IPCEventChannel.queryPort, null, expect.any(Array))
      expect(second.postMessage).toHaveBeenCalledWith(IPCEventChannel.queryPort, null, expect.any(Array))
      lastChild().emit("spawn")
      expect(postedKinds(lastChild())).toEqual([HostControlKind.attach, HostControlKind.attach])
      lastChild().emit("exit", Fixture.ExitCode)
      expect(launcher.state).toBe(QueryHostState.backoff)
    })

    it("a waiting window that closed is not served on restart", () => {
      const launcher = failedLauncher(),
        window = new FakeWebContents()
      launcher.portRequested(asWebContents(window))
      launcher.windowClosed(window.id)
      launcher.restartRequested()
      lastChild().emit("spawn")
      expect(lastChild().posted).toHaveLength(0)
    })
  })

  it.each([
    [QueryHostState.spawning, (launcher: QueryHostLauncher) => launcher.start()],
    [QueryHostState.ready, (launcher: QueryHostLauncher) => {
      launcher.start()
      lastChild().emit("spawn")
    }],
    [QueryHostState.backoff, (launcher: QueryHostLauncher) => {
      launcher.start()
      lastChild().emit("spawn")
      lastChild().emit("exit", Fixture.ExitCode)
    }]
  ])("restartRequested is a no-op in %s", (state, arrange) => {
    const launcher = newLauncher()
    arrange(launcher)
    const forks = utilityProcess.forked.length
    expect(launcher.state).toBe(state)
    launcher.restartRequested()
    expect(launcher.state).toBe(state)
    expect(utilityProcess.forked).toHaveLength(forks)
  })

  it("windowClosed while ready detaches the attached window", () => {
    const launcher = readyLauncher(),
      window = new FakeWebContents()
    launcher.portRequested(asWebContents(window))
    launcher.windowClosed(window.id)
    expect(postedKinds(lastChild())).toEqual([HostControlKind.attach, HostControlKind.detach])
  })

  it("windowClosed while queued drops the attach and closes its port1", () => {
    const launcher = newLauncher(),
      window = new FakeWebContents()
    launcher.start()
    launcher.portRequested(asWebContents(window))
    launcher.windowClosed(window.id)
    expect(launcher.queuedCount).toBe(0)
    expect(MessageChannelMain.created[0].port1.closed).toBe(true)
    lastChild().emit("spawn")
    expect(lastChild().posted).toHaveLength(0)
  })

  it("a destroyed window's port2 is closed instead of posted", () => {
    const launcher = readyLauncher(),
      window = new FakeWebContents()
    window.destroyed = true
    launcher.portRequested(asWebContents(window))
    expect(window.postMessage).not.toHaveBeenCalled()
    expect(MessageChannelMain.created[0].port2.closed).toBe(true)
  })

  it("dispose enters disposed before killing; later events are ignored", () => {
    const launcher = readyLauncher(),
      child = lastChild()
    let stateAtKill: QueryHostState = null
    child.kill.mockImplementation(() => {
      stateAtKill = launcher.state
      return true
    })
    launcher.dispose()
    expect(stateAtKill).toBe(QueryHostState.disposed)
    child.emit("exit", Fixture.ExitCode)
    jest.advanceTimersByTime(QueryHostLauncher.BackoffMaxMs)
    expect(utilityProcess.forked).toHaveLength(1)
    launcher.portRequested(asWebContents(new FakeWebContents()))
    expect(MessageChannelMain.created).toHaveLength(0)
  })

  it("dispose during backoff cancels the respawn timer", () => {
    const launcher = readyLauncher()
    lastChild().emit("exit", Fixture.ExitCode)
    launcher.dispose()
    jest.advanceTimersByTime(QueryHostLauncher.BackoffMaxMs)
    expect(utilityProcess.forked).toHaveLength(1)
    expect(launcher.state).toBe(QueryHostState.disposed)
  })
})
