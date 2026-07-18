import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { ClusterFiles } from "@wireio/cluster-tool-shared"
import {
  ApiPaths,
  type LogReadResponse,
  type LogStat
} from "@wireio/debugging-shared"

import { DebuggingServer } from "@wireio/debugging-server"

describe(`POST ${ApiPaths.Logs.Endpoint}`, () => {
  const tmpDir = Path.join(OS.tmpdir(), `log-routes-${Date.now()}`),
    logFile = Path.join(tmpDir, "data", "node_bios", "logs", "log.txt")
  let server: DebuggingServer
  let baseUrl: string
  let nextId = 1

  function rpcCall(method: string, params: any) {
    const id = nextId++
    return fetch(`${baseUrl}${ApiPaths.Logs.Endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id })
    }).then(async r => ({
      status: r.status,
      body: (await r.json()) as any
    }))
  }

  beforeAll(async () => {
    Fs.mkdirSync(Path.dirname(logFile), { recursive: true })
    Fs.writeFileSync(logFile, "alpha\nbeta\ngamma\n")
    Fs.writeFileSync(
      Path.join(tmpDir, ClusterFiles.ConfigFilename),
      JSON.stringify({ clusterPath: tmpDir })
    )
    server = await DebuggingServer.create({ clusterPath: tmpDir, port: 0 })
    const addr = await server.start()
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await server.stop()
    Fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("GetStat returns file stats", async () => {
    const { body } = await rpcCall(ApiPaths.Logs.Methods.GetStat, {
      path: logFile
    })
    const result = body.result as LogStat
    expect(result.totalLines).toBe(3)
    expect(result.totalBytes).toBe(17)
    expect(result.path).toBe(logFile)
  })

  it("Read returns a window of lines", async () => {
    const { body } = await rpcCall(ApiPaths.Logs.Methods.Read, {
      path: logFile,
      fromLine: 1,
      count: 2
    })
    const result = body.result as LogReadResponse
    expect(result.lines).toEqual(["beta", "gamma"])
  })

  it("rejects path-traversal outside clusterPath", async () => {
    const { body } = await rpcCall(ApiPaths.Logs.Methods.GetStat, {
      path: "/etc/passwd"
    })
    expect(body.error).toBeDefined()
    expect(body.error.message).toMatch(/Path traversal rejected/)
  })

  it("rejects parent-traversal even when prefix matches", async () => {
    const { body } = await rpcCall(ApiPaths.Logs.Methods.GetStat, {
      path: Path.join(tmpDir, "..", "etc", "passwd")
    })
    expect(body.error).toBeDefined()
    expect(body.error.message).toMatch(/Path traversal rejected/)
  })
})
