import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"

import { IPCChannel, IPCContract } from "@wireio/ql-tool-app/common"
import { registerIPCHandlers, type IPCHandlers } from "@wireio/ql-tool-app/main/ipc"
import { RendererTrust } from "@wireio/ql-tool-app/main/security"

import { FakeWebContents, ipcMain } from "../../__mocks__/electron.js"
import { RendererFixtures } from "../../common/RendererFixtures.js"

/** Which senders the handlers trust. */
const trust = new RendererTrust(RendererFixtures.FileURL)

/**
 * An invoke event from `sender` whose frame is at `url`.
 *
 * @param sender - The calling webContents.
 * @param url - The sender frame URL.
 * @returns The event.
 */
function invokeFrom(sender: FakeWebContents, url: string = RendererFixtures.FileURL): Partial<IpcMainInvokeEvent> {
  return { sender: sender as unknown as WebContents, senderFrame: { url } as IpcMainInvokeEvent["senderFrame"] }
}

/** One stub handler per invoke channel, each resolving its own channel name. */
function stubHandlers(): IPCHandlers {
  return Object.fromEntries(
    IPCContract.InvokeChannels.map(channel => [channel, jest.fn(async () => channel)])
  ) as unknown as IPCHandlers
}

/**
 * The function registered for `channel`.
 *
 * @param channel - Invoke channel.
 * @returns The registered ipcMain handler.
 */
function registered(channel: IPCChannel): (event: Partial<IpcMainInvokeEvent>, request: unknown) => Promise<unknown> {
  return ipcMain.handle.mock.calls.find(([name]) => name === channel)[1]
}

beforeEach(() => ipcMain.handle.mockClear())

describe("registerIPCHandlers", () => {
  it("registers every invoke channel exactly once and never a send channel", () => {
    registerIPCHandlers(ipcMain as unknown as IpcMain, stubHandlers(), trust)
    const names = ipcMain.handle.mock.calls.map(([name]) => name)
    expect([...names].sort()).toEqual([...IPCContract.InvokeChannels].sort())
    IPCContract.SendChannels.forEach(channel => expect(names).not.toContain(channel))
  })

  it("passes the request and the calling webContents to the handler", async () => {
    const handlers = stubHandlers(),
      sender = new FakeWebContents(),
      request = { limit: 5, search: "" }
    registerIPCHandlers(ipcMain as unknown as IpcMain, handlers, trust)
    await expect(
      registered(IPCChannel.historyList)(invokeFrom(sender), request)
    ).resolves.toBe(IPCChannel.historyList)
    expect(handlers.historyList).toHaveBeenCalledWith(request, sender)
  })

  it("a rejected handler rejects the invoke with the same error", async () => {
    const handlers = stubHandlers(),
      failure = new Error("disk full")
    handlers.exportWrite = jest.fn(async () => {
      throw failure
    })
    registerIPCHandlers(ipcMain as unknown as IpcMain, handlers, trust)
    await expect(
      registered(IPCChannel.exportWrite)(invokeFrom(new FakeWebContents()), {})
    ).rejects.toBe(failure)
  })

  it("refuses an invoke from a frame that is not the app's renderer before the handler runs", async () => {
    const handlers = stubHandlers()
    registerIPCHandlers(ipcMain as unknown as IpcMain, handlers, trust)
    await expect(
      registered(IPCChannel.writeQueryFile)(invokeFrom(new FakeWebContents(), "https://evil.example/"), {})
    ).rejects.toThrow(/refused writeQueryFile from an untrusted sender/)
    expect(handlers.writeQueryFile).not.toHaveBeenCalled()
  })
})
