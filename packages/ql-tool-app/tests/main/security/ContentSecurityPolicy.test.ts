import type { OnHeadersReceivedListenerDetails, Session } from "electron"

import { QLContentSecurityPolicy } from "@wireio/ql-tool-app/common"
import { ContentSecurityPolicy } from "@wireio/ql-tool-app/main/security"

import { session } from "../../__mocks__/electron.js"
import { RendererFixtures } from "../../common/RendererFixtures.js"

/**
 * Response details for `url`.
 *
 * @param url - The response URL.
 * @returns The details.
 */
function detailsOf(url: string): OnHeadersReceivedListenerDetails {
  return { url, responseHeaders: { "Content-Type": ["text/html"] } } as unknown as OnHeadersReceivedListenerDetails
}

describe("ContentSecurityPolicy", () => {
  it("dev-server responses get the Development header, keeping existing headers", () => {
    expect(ContentSecurityPolicy.headersFor(detailsOf(RendererFixtures.DevServerPageURL))).toEqual({
      responseHeaders: {
        "Content-Type": ["text/html"],
        [QLContentSecurityPolicy.HeaderName]: [QLContentSecurityPolicy.Development]
      }
    })
  })

  it("file:// responses are untouched (the meta tag governs)", () => {
    expect(ContentSecurityPolicy.headersFor(detailsOf(RendererFixtures.FileURL))).toEqual({
      responseHeaders: { "Content-Type": ["text/html"] }
    })
  })

  it("install hooks onHeadersReceived and answers through the callback", () => {
    const callback = jest.fn()
    ContentSecurityPolicy.install(session.defaultSession as unknown as Session)
    const [listener] = session.defaultSession.webRequest.onHeadersReceived.mock.calls.at(-1)
    listener(detailsOf(RendererFixtures.SecureDevServerURL), callback)
    expect(callback.mock.calls[0][0].responseHeaders[QLContentSecurityPolicy.HeaderName]).toEqual([
      QLContentSecurityPolicy.Development
    ])
  })
})
