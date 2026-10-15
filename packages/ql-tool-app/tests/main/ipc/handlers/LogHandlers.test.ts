import type { IpcMain } from "electron"
import { Level, type Appender } from "@wireio/shared"

import { IPCChannel } from "@wireio/ql-tool-app/common"
import { LogHandlers } from "@wireio/ql-tool-app/main/ipc"
import { RendererTrust } from "@wireio/ql-tool-app/main/security"

import { ipcMain } from "../../../__mocks__/electron.js"
import { RendererFixtures } from "../../../common/RendererFixtures.js"

/** A valid payload. */
const payload = { category: "renderer:App", level: Level.warn, message: "hello", timestamp: 1 }

describe("LogHandlers", () => {
  it("appends a valid payload at or above the level with its sender's category", () => {
    const appender = { append: jest.fn() } as unknown as Appender
    expect(LogHandlers.appendPayload(appender, payload, Level.info)).toBe(true)
    expect(LogHandlers.appendPayload(appender, payload, Level.warn)).toBe(true)
    expect(appender.append).toHaveBeenCalledWith(payload)
  })

  it("drops a valid payload below the level (LOG_LEVEL applies to forwarded records)", () => {
    const appender = { append: jest.fn() } as unknown as Appender
    expect(LogHandlers.appendPayload(appender, { ...payload, level: Level.debug }, Level.info)).toBe(false)
    expect(appender.append).not.toHaveBeenCalled()
  })

  it("rejects a malformed payload without writing", () => {
    const appender = { append: jest.fn() } as unknown as Appender
    expect(LogHandlers.appendPayload(appender, { ...payload, level: "loud" }, Level.trace)).toBe(false)
    expect(LogHandlers.appendPayload(appender, "text", Level.trace)).toBe(false)
    expect(appender.append).not.toHaveBeenCalled()
  })

  it("register listens on the log send channel for trusted senders only", () => {
    const appender = { append: jest.fn() } as unknown as Appender
    ipcMain.on.mockClear()
    LogHandlers.register(ipcMain as unknown as IpcMain, appender, Level.info, new RendererTrust(RendererFixtures.FileURL))
    const [channel, listener] = ipcMain.on.mock.calls[0]
    expect(channel).toBe(IPCChannel.log)
    listener({ senderFrame: { url: "https://evil.example/" } }, payload)
    expect(appender.append).not.toHaveBeenCalled()
    listener({ senderFrame: { url: RendererFixtures.FileURL } }, payload)
    expect(appender.append).toHaveBeenCalledWith(payload)
  })
})
