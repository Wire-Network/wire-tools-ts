import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { BindConfigProvider } from "@wireio/cluster-tool"

import { IPCChannel } from "@wireio/ql-tool-app/common"
import { RendererTrust } from "@wireio/ql-tool-app/main/security"

import { ipcMain } from "../../__mocks__/electron.js"
import { RendererFixtures } from "../../common/RendererFixtures.js"
import { TestHttpServer } from "../../common/TestHttpServer.js"

/** The packaged renderer page. */
const FileRenderer = RendererFixtures.FileURL
/** A dev-server renderer page (portless: the default http port). */
const HttpRenderer = RendererFixtures.DevServerURL

/** A registry-issued port: the dev server's host on another port is another origin. */
let otherPort: number = null

beforeAll(async () => {
  otherPort = await BindConfigProvider.findAvailable(TestHttpServer.PreferredPort)
  await BindConfigProvider.clearPortLocks()
})

/**
 * An IPC event whose sender frame is at `url` (null = no frame).
 *
 * @param url - The frame URL.
 * @returns The event.
 */
function eventFrom(url: string): IpcMainEvent & IpcMainInvokeEvent {
  return { senderFrame: url == null ? null : { url } } as unknown as IpcMainEvent & IpcMainInvokeEvent
}

describe("RendererTrust.isTrusted", () => {
  it("a file:// renderer trusts exactly its own file (any query or hash), nothing else", () => {
    const trust = new RendererTrust(FileRenderer)
    expect(trust.isTrusted(FileRenderer)).toBe(true)
    expect(trust.isTrusted(`${FileRenderer}?reload=1#top`)).toBe(true)
    expect(trust.isTrusted("file:///etc/passwd")).toBe(false)
    expect(trust.isTrusted("https://example.com/")).toBe(false)
    expect(trust.isTrusted("not a url")).toBe(false)
  })

  it("an http renderer trusts its origin only", () => {
    const trust = new RendererTrust(HttpRenderer)
    expect(trust.isTrusted(RendererFixtures.DevServerPageURL)).toBe(true)
    expect(trust.isTrusted(`http://${new URL(HttpRenderer).hostname}:${otherPort}/`)).toBe(false)
    expect(trust.isTrusted(RendererFixtures.SecureDevServerURL)).toBe(false)
    expect(trust.isTrusted(FileRenderer)).toBe(false)
  })

  it("an unparsable renderer URL trusts nothing", () => {
    expect(new RendererTrust("::").isTrusted(HttpRenderer)).toBe(false)
    expect(RendererTrust.parse("::")).toBeNull()
  })
})

describe("RendererTrust senders", () => {
  const trust = new RendererTrust(FileRenderer)

  it("isTrustedSender checks the sender frame (no frame = untrusted)", () => {
    expect(trust.isTrustedSender(eventFrom(FileRenderer))).toBe(true)
    expect(trust.isTrustedSender(eventFrom("https://evil.example/"))).toBe(false)
    expect(trust.isTrustedSender(eventFrom(null))).toBe(false)
  })

  it("assertSender throws naming the channel and the sender", () => {
    expect(() => trust.assertSender(eventFrom(FileRenderer), IPCChannel.profilesList)).not.toThrow()
    expect(() => trust.assertSender(eventFrom("https://evil.example/"), IPCChannel.profilesList)).toThrow(
      /refused profilesList from an untrusted sender/
    )
    expect(() => trust.assertSender(eventFrom(null), IPCChannel.profilesList)).toThrow(/senderURL=null/)
  })

  it("on registers the channel and runs the listener for trusted senders only", () => {
    const listener = jest.fn()
    ipcMain.on.mockClear()
    trust.on(ipcMain as unknown as IpcMain, IPCChannel.requestQueryPort, listener)
    const [channel, registered] = ipcMain.on.mock.calls[0]
    expect(channel).toBe(IPCChannel.requestQueryPort)
    registered(eventFrom("https://evil.example/"), undefined)
    expect(listener).not.toHaveBeenCalled()
    const trusted = eventFrom(FileRenderer)
    registered(trusted, undefined)
    expect(listener).toHaveBeenCalledWith(trusted, undefined)
  })
})
