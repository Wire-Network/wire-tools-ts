import { once } from "node:events"
import Http, { type RequestListener } from "node:http"

import { BindConfigProvider } from "@wireio/cluster-tool"

/**
 * A `node:http` server on a registry-issued loopback port — the ONE server the
 * test stubs (the stub query engine, the static renderer origin) run on. The
 * port is claimed from the bind registry (preferring {@link
 * TestHttpServer.PreferredPort}), released from the in-process lock, and bound
 * at once; a bind failure (`error` before `listening`) rejects `start`.
 */
export class TestHttpServer {
  /**
   * @param server - The listening server.
   * @param port - Its registry-issued port.
   */
  private constructor(
    readonly server: Http.Server,
    readonly port: number
  ) {}

  /** Base URL (`http://127.0.0.1:<port>`). */
  get url(): string {
    return `http://${TestHttpServer.Host}:${this.port}`
  }

  /**
   * Listen with `listener` on a registry-issued port.
   *
   * @param listener - The request handler.
   * @returns The listening server.
   * @throws Error when the port cannot be bound (the server's `error`).
   */
  static async start(listener: RequestListener): Promise<TestHttpServer> {
    const port = await BindConfigProvider.findAvailable(TestHttpServer.PreferredPort)
    await BindConfigProvider.clearPortLocks()
    const server = Http.createServer(listener)
    server.listen(port, TestHttpServer.Host)
    // `once` rejects when `error` fires first — a lost bind race fails the start instead of hanging it.
    await once(server, TestHttpServer.ListeningEvent)
    return new TestHttpServer(server, port)
  }

  /** Stop listening (open keep-alive sockets are closed too) and await the close. */
  async close(): Promise<void> {
    this.server.closeAllConnections()
    const closed = once(this.server, TestHttpServer.CloseEvent)
    this.server.close()
    await closed
  }
}

/** Server constants. */
export namespace TestHttpServer {
  /** Loopback host every stub binds. */
  export const Host = "127.0.0.1"
  /** Base for parsing a request's path (`new URL(request.url, LocalBase)`). */
  export const LocalBase = `http://${Host}`
  /** The port a test server asks the bind registry for first (any free port is issued when it is taken). */
  export const PreferredPort = 18_480
  /** `Http.Server` event once bound. */
  export const ListeningEvent = "listening"
  /** `Http.Server` event once closed. */
  export const CloseEvent = "close"
  /** HTTP 200. */
  export const OkStatus = 200
  /** HTTP 404. */
  export const NotFoundStatus = 404
}
