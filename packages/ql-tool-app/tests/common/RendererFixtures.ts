/** Renderer page URLs for the main-process suites (none is ever loaded). */
export namespace RendererFixtures {
  /** The packaged renderer page (`file://`, as `AppPaths.resolve` builds it). */
  export const FileURL = "file:///app/renderer/index.html"
  /** A dev-server renderer origin: a portless `.invalid` host (RFC 6761), never dialed. */
  export const DevServerURL = "http://renderer.invalid/"
  /** A page served by the dev server. */
  export const DevServerPageURL = `${DevServerURL}index.html`
  /** The dev server's host over https (another origin). */
  export const SecureDevServerURL = "https://renderer.invalid/"
}
