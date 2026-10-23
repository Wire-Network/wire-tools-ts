import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import Readline from "node:readline"
import { Either } from "@3fv/prelude-ts"
import { identity, isEmpty } from "lodash"
import { z } from "zod"
import {
  BindRegistrationSchemaCodec,
  ProcessSignalName,
  SchemaCodec
} from "@wireio/cluster-tool-shared"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { processCommandBasename, withFileLock } from "@wireio/cluster-tool/utils"
import { Deferred, getLogger, guard, NestedError } from "@wireio/shared"

const log = getLogger(__filename)

/**
 * The bind registry's on-disk protocol (docs/bind-registry/README.md) is shared with
 * non-Node clients — wire-sysio leases test ports from Python. These tests run a real
 * Python client against the real `BindConfigProvider` so the two implementations
 * cannot drift: the client computes the lock path and registry directory itself,
 * reads the registration Node wrote, and writes its own for Node to read.
 *
 * The client is spawned rather than replayed from a committed JSON fixture because a
 * frozen file proves only the JSON shape. The lock path derivation, the lock's mutual
 * exclusion, the temp-dir resolution, the executable a reader observes in `/proc`, and
 * the dead-owner cleanup all need a live Python process to check.
 *
 * Set WIRE_BIND_REGISTRY_PYTHON_CLIENT to run another client with the same contract
 * (wire-sysio's) in place of the fixture; see docs/bind-registry/README.md §8.
 */

/** The Python client (a reference implementation of the protocol's writer side). */
const PythonClientScript = Path.join(
  __dirname,
  "..",
  "fixtures",
  "bind-registry",
  "register_ports.py"
)
/** Interpreter the client runs under. */
const PythonExecutable = "python3"
/**
 * Env var naming another client executable to run in place of the fixture — one
 * that follows the fixture's argv/stdout/exit-code contract
 * (docs/bind-registry/README.md §8). Unset or empty runs the fixture.
 */
const ExternalClientEnvVar = "WIRE_BIND_REGISTRY_PYTHON_CLIENT"

/** How to start the client under test. */
interface ClientCommand {
  /** The executable spawned. */
  command: string
  /** Arguments before the ports. */
  leadingArgs: string[]
}

/** The client under test: {@link ExternalClientEnvVar} when set, else the fixture. */
function clientCommand(): ClientCommand {
  const { [ExternalClientEnvVar]: externalClient } = process.env
  return isEmpty(externalClient)
    ? { command: PythonExecutable, leadingArgs: [PythonClientScript] }
    : { command: externalClient, leadingArgs: [] }
}
/** proper-lockfile's lock is a directory named after its target plus this suffix. */
const ProperLockfileDirectorySuffix = ".lock"

/** The client's documented exit codes (see the script's header). */
enum PythonClientExit {
  released = 0,
  portHeld = 3,
  lockTimeout = 4,
  registrationUnreadable = 5
}

/** Which of the client's two stdout lines arrived first. */
enum HandshakeLine {
  waitingForLock = "waitingForLock",
  report = "report"
}

/** The line the client prints when it first finds the lock held. */
const WaitingForLockLine = "waiting-for-lock"
/** Name prefix of the temp dir the empty-override test points TMPDIR at. */
const TemporaryDirectoryPrefix = "bind-registry-python-tmpdir-"

/** The JSON line the Python client prints once its registration is written. */
const PythonClientReportSchema = z.object({
  /** The client's pid — its registration file is named after it. */
  pid: z.number().int(),
  /** The executable basename the client recorded as the registration's owner. */
  executable: z.string(),
  /** The registration file the client wrote. */
  registrationFile: z.string(),
  /** The lock directory the client created and removed. */
  lockDirectory: z.string(),
  /** Ports the client found held by other live registrations. */
  registeredPorts: z.array(z.number().int())
})
/** The JSON line the Python client prints — see {@link PythonClientReportSchema}. */
type PythonClientReport = z.infer<typeof PythonClientReportSchema>
/** Validating codec for {@link PythonClientReport}. */
const PythonClientReportCodec = SchemaCodec.create<PythonClientReport>(
  PythonClientReportSchema
)

/** A running Python client and its report. */
interface PythonClient {
  /** The client process; it holds its registration until its stdin closes. */
  child: ChildProcessWithoutNullStreams
  /** What the client reported after registering. */
  report: PythonClientReport
}

/** A just-launched Python client and the two lines it may print. */
interface LaunchedPythonClient {
  /** The client process; it holds its registration until its stdin closes. */
  child: ChildProcessWithoutNullStreams
  /** Settles when the client prints that it is waiting for the lock. */
  waitingForLock: Promise<void>
  /** Settles with the client's report; rejects if it exits first or cannot run. */
  report: Promise<PythonClientReport>
  /** Everything the client wrote to stderr, once its stdio has closed. */
  stderr: Promise<string>
}

const runningClients: ChildProcessWithoutNullStreams[] = []

/**
 * Launch the Python client for `ports`, following its stdout.
 *
 * @param ports - Ports for the client to register (issued by the registry).
 * @param env - The client's environment. Passed explicitly: jest gives each
 *   test file its own copy of `process.env`, and a spawn without `env`
 *   inherits the worker's real one, which lacks the sandboxed
 *   WIRE_BIND_REGISTRY_PATH set by jest.setup.ts.
 * @returns The client and its line promises.
 */
function launchPythonClient(
  ports: number[],
  env: NodeJS.ProcessEnv = process.env
): LaunchedPythonClient {
  const { command, leadingArgs } = clientCommand(),
    child = spawn(command, [...leadingArgs, ...ports.map(String)], {
      stdio: ["pipe", "pipe", "pipe"],
      env
    }),
    lines = Readline.createInterface({ input: child.stdout }),
    waitingForLock = new Deferred<void>(),
    report = new Deferred<PythonClientReport>(),
    stderr = new Deferred<string>(),
    stderrChunks: Buffer[] = []
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
  runningClients.push(child)
  // A test that does not await one of these must not see it as unhandled.
  guard(() => waitingForLock.promise)
  guard(() => report.promise)
  lines.on("line", line => {
    if (line === WaitingForLockLine) {
      waitingForLock.resolveIfUnsettled()
      return
    }
    Either.try(() => PythonClientReportCodec.deserialize(line)).match({
      Left: error => report.rejectIfUnsettled(error),
      Right: parsed => report.resolveIfUnsettled(parsed)
    })
  })
  child.once("close", code => {
    stderr.resolveIfUnsettled(Buffer.concat(stderrChunks).toString())
    const exited = new Error(`${command} exited ${code} before reporting`)
    waitingForLock.rejectIfUnsettled(exited)
    report.rejectIfUnsettled(exited)
  })
  child.once("error", error => {
    const failed = new NestedError(`could not run ${command}`, {
      cause: error,
      context: { leadingArgs }
    })
    waitingForLock.rejectIfUnsettled(failed)
    report.rejectIfUnsettled(failed)
    stderr.rejectIfUnsettled(failed)
  })
  guard(() => stderr.promise)
  return {
    child,
    waitingForLock: waitingForLock.promise,
    report: report.promise,
    stderr: stderr.promise
  }
}

/**
 * Start the Python client registering `ports` and wait for its report. Rejects
 * when the client exits first or cannot be spawned (no `python3`).
 *
 * @param ports - Ports for the client to register (issued by the registry).
 * @returns The running client and its report.
 */
async function startPythonClient(ports: number[]): Promise<PythonClient> {
  const { child, report } = launchPythonClient(ports)
  return { child, report: await report }
}

/**
 * Wait for `child` to exit and its stdio to close.
 *
 * @param child - The client process.
 * @returns Its exit code (null when a signal ended it).
 */
async function closed(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode != null || child.signalCode != null) return child.exitCode
  const [code] = await once(child, "close")
  return code
}

/**
 * The registration file the client process would write.
 *
 * @param pid - The client's pid.
 * @returns The file's path.
 */
function registrationFileOf(pid: number): string {
  return Path.join(
    BindConfigProvider.registryPath(),
    `${pid}${BindConfigProvider.RegistryFileSuffix}`
  )
}

describe("bind registry — Python client interop", () => {
  afterEach(async () => {
    await Promise.all(
      runningClients.splice(0).map(child => {
        child.stdin.destroy()
        // Best-effort — ESRCH when the client already exited.
        guard(() => process.kill(child.pid, ProcessSignalName.SIGKILL))
        return closed(child)
      })
    )
  })

  it("shares the lock, reads Node's registration, and has its own ports excluded", async () => {
    const nodeConfig = await BindConfigProvider.resolve({}, {}),
      pythonPorts = [
        await BindConfigProvider.findAvailable(BindConfigProvider.DefaultKiod),
        await BindConfigProvider.findAvailable(BindConfigProvider.DefaultAnvil)
      ]
    await BindConfigProvider.clearPortLocks()

    const { child, report } = await startPythonClient(pythonPorts)

    // Same lock and same registry dir, derived independently in Python.
    expect(report.lockDirectory).toBe(
      `${BindConfigProvider.portLockPath()}${ProperLockfileDirectorySuffix}`
    )
    expect(Fs.existsSync(report.lockDirectory)).toBe(false) // released
    expect(report.registrationFile).toBe(registrationFileOf(report.pid))
    // Python read the registration Node wrote.
    expect(report.registeredPorts).toEqual(
      expect.arrayContaining(BindConfigProvider.allPorts(nodeConfig))
    )
    // Node reads the registration Python wrote, and honors it.
    const registration = BindRegistrationSchemaCodec.deserialize(
      Fs.readFileSync(report.registrationFile)
    )
    expect(registration).toEqual({
      executable: processCommandBasename(child.pid),
      ports: pythonPorts
    })
    const exclusions = BindConfigProvider.readRegistryPortExclusions()
    pythonPorts.forEach(port => expect(exclusions.has(port)).toBe(true))
    expect(Fs.existsSync(report.registrationFile)).toBe(true) // live owner kept
    expect(await BindConfigProvider.findAvailable(pythonPorts[0])).not.toBe(
      pythonPorts[0]
    )

    child.stdin.end()
    expect(await closed(child)).toBe(PythonClientExit.released)
    expect(Fs.existsSync(report.registrationFile)).toBe(false)
  })

  it("refuses a port Node has registered, writing nothing", async () => {
    const nodeConfig = await BindConfigProvider.resolve({}, {}),
      { child } = launchPythonClient([nodeConfig.kiod.port])
    child.stdin.end()
    expect(await closed(child)).toBe(PythonClientExit.portHeld)
    expect(Fs.existsSync(registrationFileOf(child.pid))).toBe(false)
  })

  it("waits for the lock while Node holds it", async () => {
    const pythonPorts = [
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultDebuggingServer)
    ]
    await BindConfigProvider.clearPortLocks()
    const acquired = new Deferred<void>(),
      release = new Deferred<void>(),
      holding = withFileLock(BindConfigProvider.portLockPath(), () => {
        acquired.resolve()
        return release.promise
      }),
      // Observed from the start: settles with the lock's own failure, or null,
      // and never rejects — so it can be awaited in `finally` without
      // replacing the test's assertion error.
      holdingFailure = holding.then(() => null, identity<Error>)
    try {
      // `holding` rejects if the lock cannot be taken, ending the wait at once.
      await Promise.race([acquired.promise, holding])
      let reportedAt = 0
      const client = launchPythonClient(pythonPorts),
        reported = client.report.then(report => {
          reportedAt = Date.now()
          return report
        })
      // The handshake order is the contract: `waiting-for-lock` first. A
      // report first fails here instead of at the test timeout.
      const first = await Promise.race([
        client.waitingForLock.then(() => HandshakeLine.waitingForLock),
        client.report.then(() => HandshakeLine.report)
      ])
      expect(first).toBe(HandshakeLine.waitingForLock)
      // The client has found the lock held: from here it cannot report until
      // the lock is released.
      expect(reportedAt).toBe(0)
      const releasedAt = Date.now()
      release.resolve()
      await holding

      const report = await reported
      expect(reportedAt).toBeGreaterThanOrEqual(releasedAt)
      expect(Fs.existsSync(report.registrationFile)).toBe(true)
    } finally {
      // A failed expectation must not leave the lock held for later tests.
      release.resolveIfUnsettled()
      const failure = await holdingFailure
      if (failure !== null) {
        log.warn("the test's own hold of the registry lock failed", failure)
      }
    }
  })

  it("gives up with exit 4 when the lock stays held past its bounded wait", async () => {
    const pythonPorts = [
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaGossip)
    ]
    await BindConfigProvider.clearPortLocks()
    const acquired = new Deferred<void>(),
      release = new Deferred<void>(),
      // Node refreshes a held lock's mtime, so it stays fresh — never stale —
      // for as long as the client waits.
      holding = withFileLock(BindConfigProvider.portLockPath(), () => {
        acquired.resolve()
        return release.promise
      }),
      holdingFailure = holding.then(() => null, identity<Error>)
    try {
      await Promise.race([acquired.promise, holding])
      const { child } = launchPythonClient(pythonPorts)
      child.stdin.end()
      // Held until the client gives up, whatever its bounded wait.
      expect(await closed(child)).toBe(PythonClientExit.lockTimeout)
      expect(Fs.existsSync(registrationFileOf(child.pid))).toBe(false)
    } finally {
      release.resolveIfUnsettled()
      const failure = await holdingFailure
      if (failure !== null) {
        log.warn("the test's own hold of the registry lock failed", failure)
      }
    }
  })

  it("treats an empty WIRE_BIND_REGISTRY_PATH as unset, using <tmpdir>/wire-platform-bind-config", async () => {
    // TMPDIR points at a scratch dir so the default registry is not the host's.
    const temporaryPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), TemporaryDirectoryPrefix)
    )
    try {
      const port = await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultKiod
      )
      await BindConfigProvider.clearPortLocks()
      const client = launchPythonClient([port], {
          ...process.env,
          TMPDIR: temporaryPath,
          [BindConfigProvider.RegistryPathEnvVar]: ""
        }),
        report = await client.report
      expect(report.registrationFile).toBe(
        Path.join(
          temporaryPath,
          BindConfigProvider.RegistryDirectoryName,
          `${report.pid}${BindConfigProvider.RegistryFileSuffix}`
        )
      )
      expect(Path.dirname(report.lockDirectory)).toBe(temporaryPath)
      client.child.stdin.end()
      expect(await closed(client.child)).toBe(PythonClientExit.released)
    } finally {
      Fs.rmSync(temporaryPath, { recursive: true, force: true })
    }
  })

  describe("a LIVE owner's registration", () => {
    let owner: ChildProcessWithoutNullStreams
    beforeAll(() => {
      // Lives exactly as long as its stdin pipe; reaped in afterAll.
      owner = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"]
      })
    })
    afterAll(async () => {
      owner.stdin.destroy()
      guard(() => process.kill(owner.pid, ProcessSignalName.SIGKILL))
      await closed(owner)
    })

    it("that is not valid makes the client fail loudly, keeping the file and writing nothing", async () => {
      const port = await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultBiosHttp
        ),
        file = registrationFileOf(owner.pid)
      await BindConfigProvider.clearPortLocks()
      Fs.mkdirSync(BindConfigProvider.registryPath(), { recursive: true })
      Fs.writeFileSync(file, JSON.stringify([{ kiod: { port } }]))
      try {
        const { child, stderr } = launchPythonClient([port])
        child.stdin.end()
        expect(await closed(child)).toBe(PythonClientExit.registrationUnreadable)
        expect(await stderr).toContain(file)
        expect(Fs.existsSync(file)).toBe(true)
        expect(Fs.existsSync(registrationFileOf(child.pid))).toBe(false)
      } finally {
        Fs.rmSync(file, { force: true })
      }
    })

    it("recording a port as an integral float is honored", async () => {
      const port = await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultAnvil
        ),
        file = registrationFileOf(owner.pid)
      await BindConfigProvider.clearPortLocks()
      Fs.mkdirSync(BindConfigProvider.registryPath(), { recursive: true })
      // `20500.0` is JSON for an integral float; JS reads it as 20500.
      Fs.writeFileSync(file, `{"executable": "", "ports": [${port}.0]}`)
      try {
        const { child } = launchPythonClient([port])
        child.stdin.end()
        expect(await closed(child)).toBe(PythonClientExit.portHeld)
        expect(Fs.existsSync(file)).toBe(true)
      } finally {
        Fs.rmSync(file, { force: true })
      }
    })

    it("recording an empty executable is kept and its ports are honored", async () => {
      const port = await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultBiosP2p
        ),
        file = registrationFileOf(owner.pid)
      await BindConfigProvider.clearPortLocks()
      Fs.mkdirSync(BindConfigProvider.registryPath(), { recursive: true })
      Fs.writeFileSync(
        file,
        BindRegistrationSchemaCodec.serialize({ executable: "", ports: [port] })
      )
      try {
        const { child } = launchPythonClient([port])
        child.stdin.end()
        expect(await closed(child)).toBe(PythonClientExit.portHeld)
        expect(Fs.existsSync(file)).toBe(true)
      } finally {
        Fs.rmSync(file, { force: true })
      }
    })
  })

  it("deletes a dead Python owner's registration and frees its ports", async () => {
    const pythonPorts = [
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaFaucet)
    ]
    await BindConfigProvider.clearPortLocks()
    const { child, report } = await startPythonClient(pythonPorts)

    // SIGKILL: the client gets no chance to delete its own registration.
    process.kill(child.pid, ProcessSignalName.SIGKILL)
    await closed(child)
    expect(Fs.existsSync(report.registrationFile)).toBe(true)

    const exclusions = BindConfigProvider.readRegistryPortExclusions()
    expect(exclusions.has(pythonPorts[0])).toBe(false)
    expect(Fs.existsSync(report.registrationFile)).toBe(false) // reaped
  })
})
