import Fs from "node:fs"
import Path from "node:path"
import { getValue } from "@wireio/shared"

/**
 * The first argv token's basename from `/proc/<pid>/cmdline` — `""` when the
 * pid is gone, zombified, or owned by another user (the proc file is then
 * unreadable). The empty-string result is itself a liveness signal: a pid that
 * `kill(pid, 0)` says is alive but whose cmdline is empty is not verifiably
 * running anything.
 *
 * @param pid - Process id to inspect.
 * @returns The executable basename, or `""`.
 */
export function processCommandBasename(pid: number): string {
  const cmdline = getValue(
    () => Fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"),
    ""
  )
  return Path.basename(cmdline.split("\0")[0] ?? "")
}

/**
 * Whether `pid` is alive, via the signal-0 probe. `EPERM` (exists, but owned
 * by another user) counts as ALIVE — the pid is real even though this process
 * may not signal or inspect it.
 *
 * @param pid - Process id to probe.
 * @returns Whether the pid exists right now.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
