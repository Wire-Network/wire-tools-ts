import Fs from "node:fs"
import Http from "node:http"
import Net from "node:net"
import Os from "node:os"
import Path from "node:path"

import { WebSocketServer } from "ws"

import { Deferred, isString } from "@wireio/shared"
import {
  JsonRPCProtocol,
  type JsonRPCRequestEnvelope
} from "@wireio/cluster-tool-shared"
import {
  ProcessManager,
  SolanaValidatorProcess
} from "@wireio/cluster-tool/cluster/processes"
import { Localhost } from "@wireio/cluster-tool/utils"

const TestCaseTimeoutMs = 15_000

describe("Solana validator readiness", () => {
  let path: string,
    manager: ProcessManager,
    validator: SolanaValidatorProcess,
    rpc: Http.Server,
    slot: number,
    rejectRpc: boolean,
    httpRequests: JsonRPCRequestEnvelope[],
    stallRpc: boolean,
    stallRpcBody: boolean

  beforeAll(() => {
    path = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-readiness-"))
    manager = ProcessManager.setClusterPath(path).get()
  })
  beforeEach(async () => {
    validator = await SolanaValidatorProcess.create(manager, {
      binary: "/bin/true"
    })
    slot = 1
    rejectRpc = false
    httpRequests = []
    stallRpc = false
    stallRpcBody = false
    rpc = Http.createServer((request, response) => {
      if (request.method !== JsonRPCProtocol.HttpMethod) {
        response.end()
        return
      }
      let body = ""
      request.on("data", chunk => {
        body += chunk.toString()
      })
      request.on("end", () => {
        if (stallRpc) return
        const message: JsonRPCRequestEnvelope = JSON.parse(body)
        httpRequests.push(message)
        response.setHeader("Content-Type", "application/json")
        if (stallRpcBody) {
          response.write("{")
          return
        }
        response.end(
          JSON.stringify({
            jsonrpc: JsonRPCProtocol.Version,
            id: message.id,
            ...(rejectRpc
              ? {
                  error: {
                    code: JsonRPCProtocol.ErrorCode.METHOD_NOT_FOUND,
                    message: "Slot unavailable"
                  }
                }
              : { result: slot })
          })
        )
      })
    })
    await Deferred.useCallback<void>(deferred => {
      rpc.once("error", error => deferred.reject(error))
      rpc.listen(Number(new URL(validator.rpcUrl).port), Localhost, () =>
        deferred.resolve()
      )
    }).promise
  })
  afterEach(async () => {
    rpc.closeAllConnections()
    await Deferred.useCallback<void>(deferred =>
      rpc.close(() => deferred.resolve())
    ).promise
    await manager.stopAll()
  })
  afterAll(() => Fs.rmSync(path, { recursive: true, force: true }))

  it(
    "bounds a getSlot response that sends headers but never finishes its body",
    async () => {
      stallRpcBody = true
      expect(await validator.verifyReady()).toBe(false)
    },
    TestCaseTimeoutMs
  )

  it(
    "rejects HTTP-only health when the PubSub port refuses connections",
    async () => {
      expect(await validator.verifyReady()).toBe(false)
    },
    TestCaseTimeoutMs
  )

  it.each([0, -1, 1.5])(
    "rejects invalid slot %s",
    async value => {
      slot = value
      expect(await validator.verifyReady()).toBe(false)
    },
    TestCaseTimeoutMs
  )

  it("rejects an HTTP RPC error", async () => {
    rejectRpc = true
    expect(await validator.verifyReady()).toBe(false)
  })

  it(
    "bounds a stalled HTTP getSlot request",
    async () => {
      stallRpc = true
      expect(await validator.verifyReady()).toBe(false)
    },
    TestCaseTimeoutMs
  )

  it(
    "bounds a stalled WebSocket handshake and closes the TCP connection",
    async () => {
      const sockets = new Set<Net.Socket>(),
        closed: Promise<void>[] = [],
        server = Net.createServer(socket => {
          sockets.add(socket)
          socket.resume()
          closed.push(
            Deferred.useCallback<void>(deferred =>
              socket.once("close", () => {
                sockets.delete(socket)
                deferred.resolve()
              })
            ).promise
          )
        })
      try {
        await Deferred.useCallback<void>(deferred => {
          server.once("error", error => deferred.reject(error))
          server.listen(Number(new URL(validator.wsUrl).port), Localhost, () =>
            deferred.resolve()
          )
        }).promise
        expect(await validator.verifyReady()).toBe(false)
        expect(closed).toHaveLength(1)
        await Promise.all(closed)
        expect(sockets.size).toBe(0)
      } finally {
        sockets.forEach(socket => socket.destroy())
        await Deferred.useCallback<void>(deferred =>
          server.close(() => deferred.resolve())
        ).promise
      }
    },
    TestCaseTimeoutMs
  )

  it.each([
    { name: "acknowledged subscription", reply: { result: 0 }, ready: true },
    {
      name: "RPC error",
      reply: {
        error: {
          code: JsonRPCProtocol.ErrorCode.METHOD_NOT_FOUND,
          message: "PubSub unavailable"
        }
      },
      ready: false
    },
    { name: "nonnumeric subscription", reply: { result: "yes" }, ready: false },
    { name: "negative subscription", reply: { result: -1 }, ready: false },
    { name: "malformed response", reply: "not JSON", ready: false },
    {
      name: "wrong response id",
      reply: { id: "unrelated", result: 1 },
      ready: false
    },
    {
      name: "wrong protocol version",
      reply: { jsonrpc: "1.0", result: 1 },
      ready: false
    },
    { name: "unanswered subscription", reply: null, ready: false }
  ])(
    "handles $name and releases the subscription socket",
    async ({ reply, ready }) => {
      const server = new WebSocketServer({
          host: Localhost,
          port: Number(new URL(validator.wsUrl).port)
        }),
        requests: JsonRPCRequestEnvelope[] = [],
        closed: Promise<void>[] = []
      server.on("connection", socket => {
        closed.push(
          Deferred.useCallback<void>(deferred =>
            socket.once("close", () => deferred.resolve())
          ).promise
        )
        socket.on("message", data => {
          const request: JsonRPCRequestEnvelope = JSON.parse(data.toString())
          requests.push(request)
          if (reply)
            socket.send(
              isString(reply)
                ? reply
                : JSON.stringify({
                    jsonrpc: JsonRPCProtocol.Version,
                    id: request.id,
                    ...reply
                  })
            )
        })
      })
      try {
        await Deferred.useCallback<void>(deferred => {
          server.once("listening", () => deferred.resolve())
          server.once("error", error => deferred.reject(error))
        }).promise
        expect(await validator.verifyReady()).toBe(ready)
        expect(httpRequests).toEqual([
          expect.objectContaining({
            jsonrpc: JsonRPCProtocol.Version,
            id: SolanaValidatorProcess.ReadySubscriptionId,
            method: SolanaValidatorProcess.ReadySlotMethod
          })
        ])
        expect(requests).toEqual([
          {
            jsonrpc: JsonRPCProtocol.Version,
            id: SolanaValidatorProcess.ReadySubscriptionId,
            method: SolanaValidatorProcess.ReadySubscriptionMethod,
            params: []
          }
        ])
        await Promise.all(closed)
        expect(server.clients.size).toBe(0)
      } finally {
        server.clients.forEach(socket => socket.terminate())
        await Deferred.useCallback<void>(deferred =>
          server.close(() => deferred.resolve())
        ).promise
      }
    },
    TestCaseTimeoutMs
  )
})
