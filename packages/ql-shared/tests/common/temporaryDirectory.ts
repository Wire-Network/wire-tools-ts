import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

/** Accessor of the per-test directory registered by {@link useTemporaryDirectory}. */
export type TemporaryDirectory = () => string

/**
 * Give every test of the enclosing `describe` a fresh directory under the OS
 * temp dir, removed after the test.
 *
 * @param prefix - Directory name prefix.
 * @returns Accessor of the current test's directory.
 */
export function useTemporaryDirectory(prefix: string): TemporaryDirectory {
  let directory: string = null
  beforeEach(() => {
    directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix))
  })
  afterEach(() => {
    Fs.rmSync(directory, { recursive: true, force: true })
    directory = null
  })
  return () => directory
}
