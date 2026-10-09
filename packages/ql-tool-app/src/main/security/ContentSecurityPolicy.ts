import type { OnHeadersReceivedListenerDetails, HeadersReceivedResponse, Session } from "electron"

import { QLContentSecurityPolicy } from "../../common/index.js"

/**
 * Installs the CSP as a response header for http(s) loads (the dev server).
 * file:// loads carry no response headers — the `<meta>` tag injected by
 * html-webpack-plugin governs them, so they are passed through untouched.
 */
export namespace ContentSecurityPolicy {
  /** URL schemes that receive the header. */
  export const HeaderSchemes: readonly string[] = ["http:", "https:"] as const

  /**
   * The header rewrite for one response.
   *
   * @param details - The response.
   * @returns The (possibly) amended headers.
   */
  export function headersFor(details: OnHeadersReceivedListenerDetails): HeadersReceivedResponse {
    const { protocol } = new URL(details.url)
    return HeaderSchemes.includes(protocol)
      ? {
          responseHeaders: {
            ...details.responseHeaders,
            [QLContentSecurityPolicy.HeaderName]: [QLContentSecurityPolicy.Development]
          }
        }
      : { responseHeaders: details.responseHeaders }
  }

  /**
   * Install on a session.
   *
   * @param session - Usually `session.defaultSession`.
   */
  export function install(session: Session): void {
    session.webRequest.onHeadersReceived((details, callback) => callback(headersFor(details)))
  }
}
