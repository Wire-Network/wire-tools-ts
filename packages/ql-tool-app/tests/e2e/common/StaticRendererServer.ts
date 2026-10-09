import Fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import Path from "node:path"

import { AppPaths } from "@wireio/ql-tool-app/main"

import { TestHttpServer } from "../../common/TestHttpServer.js"
import { QLAppHarness } from "./QLAppHarness.js"

/**
 * Serves `dist/app/renderer` over http on a registry-issued port — an http
 * origin like webpack-dev-server's, so main's CSP response header path
 * (`ContentSecurityPolicy.install`) is exercised end to end.
 */
export class StaticRendererServer {
  /**
   * @param http - The listening server.
   */
  private constructor(private readonly http: TestHttpServer) {}

  /** The page URL. */
  get url(): string {
    return `${this.http.url}/${AppPaths.RendererFilename}`
  }

  /**
   * Start serving.
   *
   * @returns The server.
   */
  static async start(): Promise<StaticRendererServer> {
    return new StaticRendererServer(await TestHttpServer.start(StaticRendererServer.serve))
  }

  /** Stop serving. */
  close(): Promise<void> {
    return this.http.close()
  }
}

/** Server constants. */
export namespace StaticRendererServer {
  /** The served directory. */
  export const RootPath = Path.join(QLAppHarness.AppOutputPath, AppPaths.RendererSubpath)
  /** Content types by extension. */
  export const ContentTypes: Readonly<Record<string, string>> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".map": "application/json",
    ".css": "text/css",
    ".ttf": "font/ttf"
  }
  /** Content type of an unknown extension. */
  export const DefaultContentType = "application/octet-stream"

  /**
   * Answer one request with the file under {@link RootPath} (404 outside it or when missing).
   *
   * @param request - The request.
   * @param response - The response.
   */
  export function serve(request: IncomingMessage, response: ServerResponse): void {
    const relative = decodeURIComponent(new URL(request.url, TestHttpServer.LocalBase).pathname).replace(/^\/+/, ""),
      file = Path.join(RootPath, relative.length === 0 ? AppPaths.RendererFilename : relative)
    if (!file.startsWith(RootPath) || !Fs.existsSync(file)) {
      response.writeHead(TestHttpServer.NotFoundStatus).end()
      return
    }
    response.writeHead(TestHttpServer.OkStatus, { "content-type": ContentTypes[Path.extname(file)] ?? DefaultContentType })
    Fs.createReadStream(file).pipe(response)
  }
}
