import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

/** Per-suite scratch directories under the OS temp dir (removed by {@link TempDirectory.removeAll}). */
export namespace TempDirectory {
  /** Prefix of every directory this helper creates. */
  export const Prefix = "ql-tool-app-test-"

  const created: string[] = []

  /**
   * A new empty directory.
   *
   * @returns Its absolute path.
   */
  export function create(): string {
    const path = Fs.mkdtempSync(Path.join(Os.tmpdir(), Prefix))
    created.push(path)
    return path
  }

  /** Remove every directory created so far. */
  export function removeAll(): void {
    created.splice(0).forEach(path => Fs.rmSync(path, { recursive: true, force: true }))
  }
}
