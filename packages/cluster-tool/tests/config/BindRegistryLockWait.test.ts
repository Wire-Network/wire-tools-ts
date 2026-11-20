import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { z } from "zod"

import { BindConfigProvider } from "@wireio/cluster-tool/config"

/** A live holder longer than the short-file lock's 25.5-second wait budget. */
const PortLockHoldMs = 30_000

describe("bind registry lock acquisition budget", () => {
  let child: ChildProcess,
    registryPath: string,
    hostLockPath: string

  beforeAll(() => {
    hostLockPath = BindConfigProvider.portLockPath()
    registryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wire-bind-registry-lock-test-"))
    // Only synthetic protocol contention: no daemon uses these reservations.
    process.env[BindConfigProvider.RegistryPathEnvVar] = registryPath
  })

  afterEach(async () => {
    if (child == null || child.exitCode != null || child.signalCode != null) return
    const exited = once(child, "close")
    child.stdin.end()
    await exited
  })

  afterAll(() => {
    Fs.rmSync(registryPath, { recursive: true, force: true })
  })

  it("waits beyond the short-file budget without holding the host's cluster lock", async () => {
    expect(BindConfigProvider.portLockPath()).not.toBe(hostLockPath)
    child = spawn(process.execPath, [
      Path.join(__dirname, "../fixtures/bind-registry/bind-registry-owner.cjs"), "--hold-lock"
    ], { env: { ...process.env }, stdio: ["pipe", "ignore", "inherit", "ipc"] })
    const [message] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Private registry fixture exited before acquiring its lock")
      })
    ])
    expect(z.boolean().parse(message)).toBe(true)
    const startedAt = Date.now(),
      release = setTimeout(() => child.stdin.end(), PortLockHoldMs)
    try {
      const selectedPort = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp)
      expect(selectedPort).toBeGreaterThan(0)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(PortLockHoldMs)
    } finally {
      clearTimeout(release)
    }
  })
})
