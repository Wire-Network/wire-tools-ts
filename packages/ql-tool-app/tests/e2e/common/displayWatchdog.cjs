#!/usr/bin/env node
/**
 * Lifetime watchdog of the e2e X display server (Xvfb / Xephyr).
 *
 * The e2e globalSetup starts the display through this script instead of
 * spawning the server directly, so the server can never outlive the test
 * runner: the runner holds the write end of this process's stdin pipe, and the
 * kernel closes it when the runner exits for ANY reason (normal teardown,
 * Ctrl-C, SIGKILL, crash). stdin EOF therefore means "the parent is gone".
 *
 * Usage:
 *   node displayWatchdog.cjs <server> [server args...]
 *
 * Behavior:
 *   - spawns `<server> [args]` and prints ONE JSON line `{"serverPid":<pid>}` on
 *     stdout once the server process exists (the parent records it);
 *   - on stdin EOF / stdin error, SIGTERM, SIGINT or SIGHUP: SIGTERMs the server,
 *     escalates to SIGKILL after GracefulKillMs (the escalation timer is cleared
 *     once the server exits), AWAITS the server's exit, then exits 0;
 *   - when the server exits on its own, exits with the server's code (1 when it
 *     died from a signal), so the parent sees a dead display immediately.
 *
 * Exit codes:
 *   0  stopped on request (stdin EOF or a termination signal)
 *   1  the server died from a signal it was not asked to take
 *   2  usage error (no server command)
 *   3  the server could not be spawned
 *   N  the server's own exit code when it exited unprompted
 *
 * Output: stdout is this script's DATA channel — the one `{"serverPid":<pid>}`
 * line `VirtualDisplay.readServerPid` parses — so it is written raw with
 * `process.stdout.write` (no logger prefix may corrupt it). Diagnostics go to
 * stderr. The script is plain CommonJS run as a bare `node` child (no TypeScript
 * tooling loads it), so it cannot import the TypeScript signal enums; its signal
 * names are the frozen `Signal` table below.
 */
const { spawn } = require("node:child_process")

/** Grace period between SIGTERM and SIGKILL of the server (ms). */
const GracefulKillMs = 5_000
/** The POSIX signal names this script sends or handles. */
const Signal = Object.freeze({ SIGTERM: "SIGTERM", SIGINT: "SIGINT", SIGHUP: "SIGHUP", SIGKILL: "SIGKILL" })
/** Signals that stop the watchdog (and with it the server). */
const TerminationSignals = Object.freeze([Signal.SIGTERM, Signal.SIGINT, Signal.SIGHUP])
/** Documented exit codes. */
const ExitCode = { stopped: 0, signaled: 1, usage: 2, spawnFailed: 3 }

/**
 * Run the watchdog.
 *
 * @param {string[]} argv - `<server> [args...]`.
 */
function main(argv) {
  const [command, ...args] = argv
  if (command == null) {
    process.stderr.write("usage: displayWatchdog.cjs <server> [server args...]\n")
    process.exit(ExitCode.usage)
  }
  let stopping = false
  const server = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"] }),
    exited = new Promise(resolve => server.once("exit", (code, signal) => resolve({ code, signal })))
  server.once("error", error => {
    process.stderr.write(`displayWatchdog: cannot start ${command}: ${error.message}\n`)
    process.exit(ExitCode.spawnFailed)
  })
  server.once("spawn", () => process.stdout.write(`${JSON.stringify({ serverPid: server.pid })}\n`))
  exited.then(({ code }) => {
    if (!stopping) process.exit(code ?? ExitCode.signaled)
  })
  const stop = () => {
    if (stopping) return
    stopping = true
    server.kill(Signal.SIGTERM)
    const escalation = setTimeout(() => server.kill(Signal.SIGKILL), GracefulKillMs)
    exited.then(() => {
      clearTimeout(escalation)
      process.exit(ExitCode.stopped)
    })
  }
  process.stdin.once("end", stop)
  process.stdin.once("error", stop)
  process.stdin.resume()
  TerminationSignals.forEach(signal => process.on(signal, stop))
}

if (require.main === module) main(process.argv.slice(2))

module.exports = { ExitCode, GracefulKillMs, Signal, TerminationSignals }
