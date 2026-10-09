#!/usr/bin/env node
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import Path from "node:path"

/** Run one gate stage with progress and a deadline outside its event loop. */
export function runStage(
  command,
  args,
  {
    label = command,
    cwd,
    timeoutMs = 15 * 60_000,
    heartbeatMs = 30_000,
    killGraceMs = 5_000,
    stdio = "inherit"
  } = {}
) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const elapsed = () => ((performance.now() - started) / 1000).toFixed(1)
    console.log(`[check] ${label}: started`)
    const child = spawn(command, args, {
      cwd,
      stdio,
      detached: process.platform !== "win32"
    })
    let failure = null
    let escalation = null
    const signalChild = signal => {
      if (child.pid == null) return
      try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== "ESRCH")
          console.error(`[check] ${label}: ${error.message}`)
      }
    }
    const stop = reason => {
      if (failure != null) return
      failure = new Error(`[check] ${label}: ${reason} after ${elapsed()}s`)
      console.error(failure.message)
      signalChild("SIGTERM")
      escalation = setTimeout(() => signalChild("SIGKILL"), killGraceMs)
    }
    const interrupted = () => stop("interrupted")
    process.once("SIGINT", interrupted)
    process.once("SIGTERM", interrupted)
    const deadline = setTimeout(() => stop("deadline exceeded"), timeoutMs)
    const heartbeat = setInterval(
      () => console.log(`[check] ${label}: running (${elapsed()}s)`),
      heartbeatMs
    )
    const cleanup = () => {
      clearTimeout(deadline)
      clearInterval(heartbeat)
      process.removeListener("SIGINT", interrupted)
      process.removeListener("SIGTERM", interrupted)
    }
    child.once("error", error => {
      cleanup()
      clearTimeout(escalation)
      reject(
        new Error(`[check] ${label}: could not start ${command}`, {
          cause: error
        })
      )
    })
    child.once("close", (code, signal) => {
      cleanup()
      // On a timeout keep the escalation alive even if the direct child exits:
      // pnpm's descendants may ignore TERM and still belong to the group.
      if (failure != null) reject(failure)
      else if (code !== 0)
        reject(
          new Error(
            `[check] ${label}: failed (${signal ?? code}) after ${elapsed()}s`
          )
        )
      else {
        clearTimeout(escalation)
        console.log(`[check] ${label}: passed (${elapsed()}s)`)
        resolve()
      }
    })
  })
}

export async function check() {
  const cwd = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..")
  await runStage("pnpm", ["lint"], { cwd, label: "lint", timeoutMs: 120_000 })
  await runStage("pnpm", ["test"], { cwd, label: "build and all unit tests" })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  check().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
