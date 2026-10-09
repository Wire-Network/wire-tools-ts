import type { IpcMain, IpcMainEvent, WebContents } from "electron"

import { IPCChannel } from "@wireio/ql-tool-app/common"
import { QueryPortHandlers } from "@wireio/ql-tool-app/main/ipc"
import type { QueryHostLauncher } from "@wireio/ql-tool-app/main/query"
import { RendererTrust } from "@wireio/ql-tool-app/main/security"

import { FakeWebContents, ipcMain } from "../../../__mocks__/electron.js"
import { RendererFixtures } from "../../../common/RendererFixtures.js"

/** The trusted sender frame. */
const TrustedFrame = { url: RendererFixtures.FileURL } as IpcMainEvent["senderFrame"]

/**
 * The listener registered for `channel`.
 *
 * @param channel - Send channel.
 * @returns The listener.
 */
function listenerOf(channel: IPCChannel): (event: Partial<IpcMainEvent>) => void {
  return ipcMain.on.mock.calls.find(([name]) => name === channel)[1]
}

describe("QueryPortHandlers", () => {
  const launcher = { portRequested: jest.fn(), restartRequested: jest.fn() } as unknown as QueryHostLauncher

  beforeAll(() => {
    ipcMain.on.mockClear()
    QueryPortHandlers.register(ipcMain as unknown as IpcMain, launcher, new RendererTrust(RendererFixtures.FileURL))
  })

  it("a port request is served for the sending window", () => {
    const sender = new FakeWebContents()
    listenerOf(IPCChannel.requestQueryPort)({ sender: sender as unknown as WebContents, senderFrame: TrustedFrame })
    expect(launcher.portRequested).toHaveBeenCalledWith(sender)
  })

  it("restart goes to the launcher and requests no port", () => {
    jest.mocked(launcher.portRequested).mockClear()
    listenerOf(IPCChannel.restartQueryHost)({ senderFrame: TrustedFrame })
    expect(launcher.restartRequested).toHaveBeenCalledTimes(1)
    expect(launcher.portRequested).not.toHaveBeenCalled()
  })

  it("ignores port requests and restarts from untrusted frames", () => {
    jest.mocked(launcher.portRequested).mockClear()
    jest.mocked(launcher.restartRequested).mockClear()
    const untrusted = { url: "https://evil.example/" } as IpcMainEvent["senderFrame"]
    listenerOf(IPCChannel.requestQueryPort)({ sender: new FakeWebContents() as unknown as WebContents, senderFrame: untrusted })
    listenerOf(IPCChannel.restartQueryHost)({ senderFrame: untrusted })
    expect(launcher.portRequested).not.toHaveBeenCalled()
    expect(launcher.restartRequested).not.toHaveBeenCalled()
  })
})
