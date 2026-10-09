#!/usr/bin/env node
/**
 * The repo gate: package root layout, engine-derived artifact drift (source files only, so a
 * clean clone passes before any build), desktop app icon drift, lint, then build + every unit
 * test — one stage at a time, each under its own deadline.
 *
 * Every stage runs in its own process group: a deadline or an interrupt (SIGINT / SIGTERM)
 * sends TERM to the whole group, then KILL after a grace period, so a TERM-resistant
 * descendant (a stray jest worker) never outlives the gate.
 *
 * Usage:
 *   ./scripts/check.mjs           (takes no options or arguments)
 *
 * Exit codes:
 *   0  every stage passed
 *   1  a stage failed, exceeded its deadline, could not start, or was interrupted
 *   2  usage error (any option or argument was given)
 *
 * A stage that exits 127 is reported as "could not start" (the shell's "command not found");
 * a stage killed by a signal — directly, or reported by the shell as exit 128+N — is reported
 * with the signal's name.
 *
 * Examples:
 *   ./scripts/check.mjs
 *   pnpm check
 */

import { $, chalk, echo, os, path } from "zx"

import { ExitCode, RepoRoot, isEntryScript, parseArguments } from "./common/cli-common.mjs"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default stage deadline (build + every test fits well inside it on a loaded host). */
const DefaultStageTimeoutMs = 15 * 60_000

/** Deadline of a quick stage (a drift check or lint). */
const QuickStageTimeoutMs = 120_000

/** Interval of the "still running" line. */
const DefaultHeartbeatMs = 30_000

/** Grace between TERM and KILL for a stage's process group. */
const DefaultKillGraceMs = 5_000

/** Shell exit status for "command not found". */
const CommandNotFoundExitCode = 127

/** Offset the shell adds to a signal number when its child is killed by that signal. */
const ShellSignalExitOffset = 128

/** Signal name by number (for shell-reported 128+N exits). */
const SignalNames = Object.freeze(
  Object.fromEntries(Object.entries(os.constants.signals).map(([name, number]) => [number, name]))
)

/** Signals that interrupt the active stage. */
const InterruptSignals = Object.freeze(["SIGINT", "SIGTERM"])

/** Milliseconds per second (elapsed-time display). */
const MsPerSecond = 1000

/** Repository scripts (executables) run as stages, in gate order, before lint. */
const ScriptStages = Object.freeze([
  { label: "package-layout-check", script: "check-package-layout.mjs", args: [] },
  { label: "wql-types-check", script: "generate-wql-types.mjs", args: ["--check"] },
  { label: "ql-app-icons-check", script: "generate-ql-app-icons.mjs", args: ["--check"] }
])

/** The full gate, in order. */
const Stages = Object.freeze([
  ...ScriptStages.map(({ label, script, args }) => ({
    label,
    command: path.join(RepoRoot, "scripts", script),
    args,
    timeoutMs: QuickStageTimeoutMs
  })),
  { label: "lint", command: "pnpm", args: ["lint"], timeoutMs: QuickStageTimeoutMs },
  { label: "build and all unit tests", command: "pnpm", args: ["test"], timeoutMs: DefaultStageTimeoutMs }
])

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

/**
 * Signal a stage's whole process group, ignoring a group that already exited.
 *
 * @param {number} pid the group leader's pid.
 * @param {string} signal the signal name.
 */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== "ESRCH") echo(chalk.red(`[check] could not send ${signal} to group ${pid}: ${error.message}`))
  }
}

/**
 * Describe a non-zero stage outcome: the signal name when the child was killed by one (directly,
 * or reported by the shell as exit 128+N), else the exit code.
 *
 * @param {{ exitCode: number|null, signal: string|null }} output the stage's process output.
 * @return {string} e.g. `7`, `SIGKILL`, or `exited 143 (SIGTERM)`.
 */
function describeExit({ exitCode, signal }) {
  if (signal != null) return signal
  const shellSignal = exitCode > ShellSignalExitOffset ? SignalNames[exitCode - ShellSignalExitOffset] : null
  return shellSignal == null ? String(exitCode) : `exited ${exitCode} (${shellSignal})`
}

/**
 * Run one gate stage with progress, a deadline enforced outside the child's event loop, and
 * TERM → KILL escalation over the stage's process group.
 *
 * @param {string} command the executable.
 * @param {string[]} args its arguments.
 * @param {object} [options]
 * @param {string} [options.label] stage name in the progress lines (default: the command).
 * @param {string} [options.cwd] working directory (default: the repository root).
 * @param {number} [options.timeoutMs] deadline.
 * @param {number} [options.heartbeatMs] "still running" interval.
 * @param {number} [options.killGraceMs] grace between TERM and KILL.
 * @param {string} [options.stdio] child stdio (`inherit` for the gate, `ignore` in tests).
 * @return {Promise<void>} resolves when the stage passes; rejects with the reason otherwise.
 */
export async function runStage(
  command,
  args,
  {
    label = command,
    cwd = RepoRoot,
    timeoutMs = DefaultStageTimeoutMs,
    heartbeatMs = DefaultHeartbeatMs,
    killGraceMs = DefaultKillGraceMs,
    stdio = "inherit"
  } = {}
) {
  const started = performance.now(),
    elapsed = () => ((performance.now() - started) / MsPerSecond).toFixed(1),
    child = $({ cwd, stdio, detached: true, nothrow: true })`${command} ${args}`
  let failure = null,
    escalation = null
  const stop = reason => {
      if (failure != null) return
      failure = new Error(`[check] ${label}: ${reason} after ${elapsed()}s`)
      echo(chalk.red(failure.message))
      signalGroup(child.pid, "SIGTERM")
      escalation = setTimeout(() => signalGroup(child.pid, "SIGKILL"), killGraceMs)
    },
    interrupted = () => stop("interrupted"),
    deadline = setTimeout(() => stop("deadline exceeded"), timeoutMs),
    heartbeat = setInterval(() => echo(`[check] ${label}: running (${elapsed()}s)`), heartbeatMs)
  echo(`[check] ${label}: started`)
  InterruptSignals.forEach(signal => process.once(signal, interrupted))
  const output = await child.finally(() => {
    clearTimeout(deadline)
    clearInterval(heartbeat)
    InterruptSignals.forEach(signal => process.removeListener(signal, interrupted))
  })
  // On a deadline or interrupt the escalation stays armed even after the direct child exits:
  // descendants may ignore TERM and still belong to the group.
  if (failure != null) throw failure
  clearTimeout(escalation)
  if (output.exitCode === CommandNotFoundExitCode)
    throw new Error(`[check] ${label}: could not start ${command}: exited ${CommandNotFoundExitCode} (command not found)`)
  if (output.exitCode !== ExitCode.success)
    throw new Error(`[check] ${label}: failed (${describeExit(output)}) after ${elapsed()}s`)
  echo(`[check] ${label}: passed (${elapsed()}s)`)
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Run every gate stage in order, stopping at the first failure.
 *
 * @return {Promise<void>} resolves when every stage passed.
 */
export async function check() {
  await Stages.reduce(
    (previous, { label, command, args, timeoutMs }) =>
      previous.then(() => runStage(command, args, { cwd: RepoRoot, label, timeoutMs })),
    Promise.resolve()
  )
}

if (isEntryScript(import.meta.filename)) {
  parseArguments()
  process.exitCode = await check().then(
    () => ExitCode.success,
    error => {
      echo(chalk.red(error.message))
      return ExitCode.failure
    }
  )
}
