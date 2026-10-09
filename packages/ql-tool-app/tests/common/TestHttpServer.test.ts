import Http from "node:http"

import { TestHttpServer } from "./TestHttpServer.js"

/**
 * GET `url` and read the body.
 *
 * @param url - The URL.
 * @returns Status and body.
 */
async function get(url: string): Promise<[number, string]> {
  const response = await fetch(url)
  return [response.status, await response.text()]
}

describe("TestHttpServer", () => {
  it("serves its listener on a registry-issued loopback port and closes", async () => {
    const server = await TestHttpServer.start((_request, response) => response.writeHead(TestHttpServer.OkStatus).end("pong"))
    try {
      expect(server.url).toBe(`http://${TestHttpServer.Host}:${server.port}`)
      expect(await get(server.url)).toEqual([TestHttpServer.OkStatus, "pong"])
    } finally {
      await server.close()
    }
    expect(server.server.listening).toBe(false)
  })

  it("rejects when the port cannot be bound (error before listening)", async () => {
    const listen = jest.spyOn(Http.Server.prototype, "listen").mockImplementationOnce(function (this: Http.Server) {
        process.nextTick(() => this.emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" })))
        return this
      })
    try {
      await expect(TestHttpServer.start((_request, response) => response.end())).rejects.toThrow("EADDRINUSE")
    } finally {
      listen.mockRestore()
    }
  })
})
