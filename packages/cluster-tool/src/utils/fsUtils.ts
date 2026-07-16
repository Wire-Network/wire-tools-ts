import Fs from "node:fs"
import Path from "node:path"
import lockfile from "proper-lockfile"
import type { LockOptions } from "proper-lockfile"
import { which as zxWhich } from "zx"
import { getLogger } from "@wireio/shared"

const log = getLogger(__filename)

/**
 * proper-lockfile options for the short critical sections {@link withFileLock}
 * guards: bounded exponential-backoff retries so a contending process waits
 * rather than fails, plus a 10s stale-lock steal so a crashed holder can't
 * wedge the resource. `realpath: false` lets the lock target not pre-exist.
 *
 * Changing these tunes how long a contending process blocks before giving up
 * (retries) and how long a dead holder's lock survives (stale).
 */
const FileLockOptions: LockOptions = {
  realpath: false,
  retries: { retries: 5, factor: 2, minTimeout: 100 },
  stale: 10_000
}

/**
 * True if a file, directory, or symlink exists at `path`. Resolves to `false`
 * (never rejects) when the path is missing — distinct from the raw
 * `Fs.promises.lstat`, which throws `ENOENT`.
 *
 * @param path - Filesystem path to probe.
 * @returns Whether something exists at `path`.
 */
export function existsAsync(path: string): Promise<boolean> {
  return Fs.promises.lstat(path).then(
    stats => stats.isFile() || stats.isDirectory() || stats.isSymbolicLink(),
    () => false
  )
}

/**
 * Recursively create `path` (and any missing parents), returning `path` so the
 * call composes fluently into a directory expression.
 *
 * @param path - Directory to create.
 * @returns The created `path`, unchanged.
 */
export function mkdirs(path: string): string {
  Fs.mkdirSync(path, { recursive: true })
  return path
}

/**
 * Resolve an executable's absolute path from `PATH`, or `null` when it is not
 * found. Wraps `zx`'s `which` in its non-throwing mode so a missing binary is
 * a `null` value, not an exception — callers fail fast with their own context.
 *
 * @param command - Executable name to resolve (e.g. `"anvil"`).
 * @returns The resolved absolute path, or `null` if not on `PATH`.
 */
export async function which(command: string): Promise<string | null> {
  return (await zxWhich(command, { nothrow: true })) ?? null
}

/**
 * A filesystem-safe timestamp (`2026-06-30T12-00-00-000Z`) suitable for log
 * filenames — the ISO-8601 string with `:` and `.` replaced by `-`.
 *
 * @returns The current time as a filename-safe stamp.
 */
export function currentDateStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

/**
 * Run `criticalSection` while holding a cross-process advisory lock on `lockPath`
 * (via `proper-lockfile`). Any other process calling this with the SAME `lockPath`
 * blocks (bounded retries — see {@link FileLockOptions}) until the lock releases,
 * so the guarded work is serialized ACROSS processes — e.g. multiple `flow-*` /
 * `wire-cluster-tool` runs selecting network ports concurrently. The lock target's
 * parent directory is created if absent; `realpath: false` lets the target file
 * itself not pre-exist (the mutex is its `.lock` sibling). The lock is always
 * released, even if the critical section throws.
 *
 * @param lockPath - Path whose `.lock` sibling is the mutex; use a host-global
 *   path so all contending processes share the same mutex.
 * @param criticalSection - The async work to run exclusively under the lock.
 * @returns The critical section's resolved value.
 */
export async function withFileLock<T>(
  lockPath: string,
  criticalSection: () => Promise<T>,
  options: LockOptions = FileLockOptions
): Promise<T> {
  mkdirs(Path.dirname(lockPath))
  const release = await lockfile.lock(lockPath, options)
  try {
    return await criticalSection()
  } finally {
    // A release failure must never mask the critical section's outcome: after
    // a compromised (stale-stolen) lock, proper-lockfile marks this holder
    // released before invoking onCompromised, so release() rejects with
    // ERELEASED — the lock is gone either way.
    await release().catch(err =>
      log.warn(
        `file lock release failed for ${lockPath} (already released?)`,
        err
      )
    )
  }
}

/**
 * proper-lockfile options for LONG critical sections (a hardhat deploy holds
 * for 30–120s): fixed-interval retries wait out a full holder's run instead of
 * giving up after the default ~3s backoff. The 10s stale threshold stays safe
 * for long holds — proper-lockfile auto-refreshes a live holder's lock mtime.
 *
 * Changing `retries`/`minTimeout` bounds how long a contender waits for the
 * current holder (retries × minTimeout).
 */
export const LongFileLockOptions: LockOptions = {
  realpath: false,
  retries: { retries: 120, factor: 1, minTimeout: 2_000, maxTimeout: 2_000 },
  stale: 10_000
}
