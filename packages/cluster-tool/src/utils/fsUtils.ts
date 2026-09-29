import Fs from "node:fs"
import Path from "node:path"
import lockfile from "proper-lockfile"
import type { LockOptions } from "proper-lockfile"
import { which as zxWhich } from "zx"
import { Deferred, getLogger, guard, NestedError } from "@wireio/shared"

const log = getLogger(__filename)

/**
 * proper-lockfile options for the short critical sections {@link withFileLock}
 * guards: bounded exponential-backoff retries so a contending process waits
 * rather than fails, plus a 10s stale-lock steal so a crashed holder can't
 * wedge the resource. `realpath: false` lets the lock target not pre-exist.
 *
 * Changing these tunes how long a contending process blocks before giving up
 * (retries) and how long a dead holder's lock survives (stale). The ~25s
 * cumulative retry budget (`retries: 8`) is sized for the WORST short-section
 * holder under contention: a solana dynamic-range pick TCP+UDP-probes a
 * 64-port window while holding the port lock (seconds on a loaded host), and
 * the full jest run puts all 8 projects' port-resolving tests behind the SAME
 * host-global lock — the previous ~6s budget failed a rotating victim test
 * with `Lock file is already being held`.
 *
 * `onCompromised` is deliberately absent: {@link withFileLock} owns it, because
 * the handler has to fail the ONE in-flight critical section that lost the lock.
 */
const FileLockOptions: LockOptions = {
  realpath: false,
  retries: { retries: 8, factor: 2, minTimeout: 100 },
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
export async function which(command: string): Promise<string> {
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
 * Turn a `proper-lockfile` compromise notification into a deterministic
 * rejection of the critical section that lost its exclusivity.
 *
 * `proper-lockfile` discovers the loss on its own `unref`'d mtime-refresh
 * timer, rewrites the failing syscall error IN PLACE to `ECOMPROMISED` (its
 * `ENOENT … stat '…/<target>.lock'` text intact) and hands it to
 * `onCompromised`, whose DEFAULT implementation re-THROWS it. That throw has
 * no call-stack relationship to the code holding the lock: it is an uncaught
 * exception that, under jest, fails whatever test happens to be running
 * instead of the caller still sitting inside the section. Rejecting
 * `compromised` hands the failure to that caller, original error preserved as
 * the cause.
 *
 * @param compromised - Deferred whose rejection aborts the critical section.
 * @param lockPath - The lock whose exclusivity was lost.
 * @param err - proper-lockfile's `ECOMPROMISED` error, preserved as the cause.
 */
function rejectCompromised(
  compromised: Deferred<never>,
  lockPath: string,
  err: Error
): void {
  log.error(
    `file lock for ${lockPath} was compromised while held — its critical section is no longer exclusive`,
    err
  )
  compromised.rejectIfUnsettled(
    new NestedError(
      "file lock was compromised while its critical section was running",
      { cause: err, context: { lockPath } }
    )
  )
}

/**
 * Log a critical section that failed AFTER a compromise already decided the
 * call's outcome. That failure has nowhere else to go — the caller was handed
 * the compromise — so without this it vanishes silently. An ordinary section
 * failure is NOT logged here: it IS the value the call rejects with, and the
 * caller owns it.
 *
 * @param compromised - Deferred carrying the compromise, if one landed.
 * @param lockPath - The lock the section was holding.
 * @param err - The critical section's own late failure.
 */
function logLateSectionFailure(
  compromised: Deferred<never>,
  lockPath: string,
  err: Error
): void {
  if (compromised.isRejected()) {
    log.warn(
      `file lock for ${lockPath}: critical section failed after the lock was lost`,
      err
    )
  }
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
 * If the lock is COMPROMISED mid-section (another process stole it as stale, or
 * its directory was removed), this call REJECTS with a `NestedError` carrying
 * proper-lockfile's `ECOMPROMISED` error as the cause — the section's own work
 * is no longer exclusive, so its result is not returned. The section itself is
 * NOT cancelled: it runs to completion and its side effects are not undone.
 * `onCompromised` is therefore owned here and overrides any value on `options`.
 *
 * @param lockPath - Path whose `.lock` sibling is the mutex; use a host-global
 *   path so all contending processes share the same mutex.
 * @param criticalSection - The async work to run exclusively under the lock.
 * @param options - proper-lockfile options; defaults to {@link FileLockOptions}
 *   ({@link LongFileLockOptions} for holds measured in minutes).
 * @returns The critical section's resolved value.
 */
export async function withFileLock<T>(
  lockPath: string,
  criticalSection: () => Promise<T>,
  options: LockOptions = FileLockOptions
): Promise<T> {
  mkdirs(Path.dirname(lockPath))
  const compromised = new Deferred<never>()
  // A compromise can land AFTER the section settled, when nothing awaits it any
  // more — swallow that late rejection instead of leaving it unhandled.
  guard(() => compromised.promise)
  const release = await lockfile.lock(lockPath, {
    ...options,
    onCompromised: err => rejectCompromised(compromised, lockPath, err)
  })
  const releaseLock = async (propagateUnexpected: boolean): Promise<void> => {
    try {
      await release()
    } catch (err) {
      // ERELEASED is the one EXPECTED rejection: after a compromised
      // (stale-stolen) lock, proper-lockfile marks this holder released
      // before invoking onCompromised, so the lock is gone either way.
      if ((err as NodeJS.ErrnoException)?.code === "ERELEASED") {
        log.warn(`file lock for ${lockPath} was already released (compromised)`)
        return
      }
      // Anything else (EACCES, EIO, ...) may leave the lock dir behind and
      // wedge later contenders — surface it unless the critical section's own
      // error already owns the outcome.
      log.error(`file lock release failed for ${lockPath}`, err)
      if (propagateUnexpected) {
        throw err
      }
    }
  }
  let result: T
  try {
    // Bound to a local because the race subscribes to it: a compromise only
    // stops THIS call from waiting — the section is not cancelled and keeps
    // running, so its late outcome needs a home of its own.
    const section = criticalSection()
    guard(
      () => section,
      err => logLateSectionFailure(compromised, lockPath, err)
    )
    result = await Promise.race([section, compromised.promise])
  } catch (err) {
    // The critical section's error owns the outcome; a release failure here
    // is logged but must not mask it.
    await releaseLock(false)
    throw err
  }
  await releaseLock(true)
  return result
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
