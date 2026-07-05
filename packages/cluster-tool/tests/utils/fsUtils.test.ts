import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  currentDateStamp,
  existsAsync,
  mkdirs,
  which,
  withFileLock
} from "@wireio/cluster-tool/utils"

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
  })
})
