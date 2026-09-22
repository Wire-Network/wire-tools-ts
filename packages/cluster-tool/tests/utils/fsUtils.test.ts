import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { LockOptions } from "proper-lockfile"
import { identity } from "lodash"
import { Deferred, NestedError } from "@wireio/shared"
import {
  currentDateStamp,
  existsAsync,
  mkdirs,
  which,
  withFileLock
} from "@wireio/cluster-tool/utils"

/** Suffix proper-lockfile appends to the lock target to name its mutex dir. */
const LockDirSuffix = ".lock"
/** The syscall `proper-lockfile` rewrites in place to `ECOMPROMISED`. */
const CompromisedCauseFragment = "ENOENT"
/** proper-lockfile's floor for `stale` (it clamps anything lower). */
const MinimumStaleMs = 2_000
/** proper-lockfile's floor for `update` (it clamps anything lower). */
const MinimumUpdateMs = 1_000
/**
 * Options that drive a compromise deterministically: proper-lockfile's own
 * minimum stale/update, so the refresh that discovers the removed lock dir
 * fires ~1s after acquisition rather than on the shipped 5s cadence.
 */
const CompromiseProbeLockOptions: LockOptions = {
  realpath: false,
  stale: MinimumStaleMs,
  update: MinimumUpdateMs
}

describe("fsUtils", () => {
  let dir: string
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "fsutils-"))
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  describe("existsAsync", () => {
    it("is true for an existing directory and file", async () => {
      expect(await existsAsync(dir)).toBe(true)
      const file = Path.join(dir, "f.txt")
      Fs.writeFileSync(file, "x")
      expect(await existsAsync(file)).toBe(true)
    })
    it("resolves false (never rejects) for a missing path", async () => {
      expect(await existsAsync(Path.join(dir, "missing"))).toBe(false)
    })
  })

  describe("mkdirs", () => {
    it("recursively creates the path and returns it", () => {
      const nested = Path.join(dir, "a", "b", "c")
      expect(mkdirs(nested)).toBe(nested)
      expect(Fs.existsSync(nested)).toBe(true)
    })
  })

  describe("which", () => {
    it("resolves a known executable on PATH", async () => {
      expect(await which("node")).toMatch(/node/)
    })
    it("returns null for a missing executable", async () => {
      expect(await which("definitely-not-a-real-binary-xyz")).toBeNull()
    })
  })

  describe("currentDateStamp", () => {
    it("is filesystem-safe (no ':' or '.') and ISO-shaped", () => {
      const stamp = currentDateStamp()
      expect(stamp).not.toMatch(/[:.]/)
      expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe("withFileLock", () => {
    it("runs the critical section and returns its value", async () => {
      expect(await withFileLock(Path.join(dir, "a"), async () => 42)).toBe(42)
    })

    it("releases the lock even when the critical section throws", async () => {
      const lockPath = Path.join(dir, "b")
      await expect(
        withFileLock(lockPath, async () => {
          throw new Error("boom")
        })
      ).rejects.toThrow("boom")
      // released → a subsequent acquisition on the same path succeeds
      expect(await withFileLock(lockPath, async () => "ok")).toBe("ok")
    })

    // Regression guard (not new behaviour): the section is invoked inside the
    // try, so a throw before it ever returns a promise still releases the lock.
    it("releases the lock when the critical section throws SYNCHRONOUSLY", async () => {
      const lockPath = Path.join(dir, "sync-throw")
      await expect(
        withFileLock(lockPath, (): Promise<never> => {
          throw new Error("boom")
        })
      ).rejects.toThrow("boom")
      // A leaked lock here would wedge every later contender on this path until
      // the staleness threshold — the acquisition below proves it was released.
      expect(await withFileLock(lockPath, async () => "ok")).toBe("ok")
    })

    it("serializes overlapping calls on the same lock path (mutual exclusion)", async () => {
      const lockPath = Path.join(dir, "c")
      let active = 0
      let maxActive = 0
      const critical = async (): Promise<void> => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 30))
        active -= 1
      }
      await Promise.all([
        withFileLock(lockPath, critical),
        withFileLock(lockPath, critical),
        withFileLock(lockPath, critical)
      ])
      // never two critical sections in flight at once
      expect(maxActive).toBe(1)
    })

    it("rejects the in-flight critical section when the held lock is compromised", async () => {
      const lockPath = Path.join(dir, "compromised"),
        acquired = new Deferred<void>(),
        section = new Deferred<string>()
      const held = withFileLock(
        lockPath,
        () => {
          acquired.resolve()
          return section.promise
        },
        CompromiseProbeLockOptions
      )
      await acquired.promise
      // Exactly what a stale steal does (a contender removes the lock dir before
      // re-creating it), and what a fixture deleting a still-locked registry dir
      // does: the holder's next refresh stat ENOENTs → ECOMPROMISED. Without
      // withFileLock's onCompromised, proper-lockfile's default handler re-throws
      // that from its refresh timer and this call never settles at all.
      Fs.rmSync(`${lockPath}${LockDirSuffix}`, { recursive: true, force: true })

      const failure = await held.then(() => null, identity<NestedError>)
      expect(failure).toBeInstanceOf(NestedError)
      expect(failure.message).toContain(lockPath)
      // jest runs the suite in a vm sandbox, so an error raised in an fs callback
      // fails the host realm's `instanceof Error` and `NestedError` coerces it —
      // only the MESSAGE survives here (outside jest the cause passes through).
      expect(failure.causes).toHaveLength(1)
      expect(failure.causes[0].message).toContain(CompromisedCauseFragment)
      expect(failure.causes[0].message).toContain(`${lockPath}${LockDirSuffix}`)
    })
  })
})
