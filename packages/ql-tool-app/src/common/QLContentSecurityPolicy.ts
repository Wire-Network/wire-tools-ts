/**
 * The app's Content-Security-Policy — one spelling for the `<meta>` tag (file://
 * loads, where response headers do not apply) and the response header installed
 * for dev-server (http://localhost) loads.
 */
export namespace QLContentSecurityPolicy {
  /** The `<meta http-equiv>` / response header name. */
  export const HeaderName = "Content-Security-Policy"

  /**
   * Packaged / file:// loads (the `<meta>` tag). Monaco + emotion need inline
   * styles; Monaco workers load from self or blob:; the codicon font and small
   * images may be data: URIs; the renderer makes no network requests.
   */
  export const Production = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ")

  /**
   * Directives only a response header can deliver: Chromium ignores
   * `frame-ancestors` in a `<meta>` tag (and logs an error), so it rides the header.
   */
  export const HeaderOnly = ["frame-ancestors 'none'"].join("; ")

  /**
   * webpack-dev-server `<meta>` tag: {@link Production} plus the HMR websocket in
   * connect-src — no header-only directive, so Chromium accepts the whole tag.
   */
  export const DevelopmentMeta = Production.replace("connect-src 'self'", "connect-src 'self' ws://localhost:*")

  /** webpack-dev-server response header: {@link DevelopmentMeta} plus the header-only directives. */
  export const Development = [DevelopmentMeta, HeaderOnly].join("; ")
}
