import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import Http from "node:http"
import Path from "node:path"
import { z } from "zod"

import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { Localhost } from "@wireio/cluster-tool/utils"
import { Deferred } from "@wireio/shared"

/** Model a flow using the host registry, independently of Jest's environment copy. */
function launchRegistryOwner(): ChildProcess {
  const environment = { ...process.env }
  delete environment[BindConfigProvider.RegistryPathEnvVar]
  return spawn(
    process.execPath,
    [Path.join(__dirname, "../fixtures/bind-registry/reserve-host-port.cjs")],
    { env: environment, stdio: ["pipe", "ignore", "inherit", "ipc"] }
  )
}

describe("host bind reservations in real socket tests", () => {
  let child: ChildProcess

  afterEach(async () => {
    if (child == null) return
    if (child.exitCode != null || child.signalCode != null) {
      child = null
      return
    }
    const exited = once(child, "close")
    child.stdin.end()
    await exited
    child = null
  })

  it("excludes a live cluster's unbound reservation before binding a stub server", async () => {
    // The child models a flow in the host registry. A suite-wide registry
    // override used to hide its reservation from this real socket fixture.
    child = launchRegistryOwner()
    const [message] = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => {
          throw new Error("Host registry fixture exited before publishing its reservation")
        })
      ]),
      reservedPort = z.number().int().parse(message),
      selectedPort = await BindConfigProvider.findAvailable(reservedPort)
    expect(selectedPort).not.toBe(reservedPort)

    await BindConfigProvider.clearPortLocks()
    const server = Http.createServer()
    try {
      const listening = Deferred.useCallback<void>(deferred => {
        server.once("error", error => deferred.reject(error))
        server.listen(selectedPort, Localhost, () => deferred.resolve())
      })
      await listening.promise
      expect(server.listening).toBe(true)
    } finally {
      if (server.listening) {
        await Deferred.useCallback<void>(deferred => {
          server.close(error => (error ? deferred.reject(error) : deferred.resolve()))
        }).promise
      }
    }
  })
})
