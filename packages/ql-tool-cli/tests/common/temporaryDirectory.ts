import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

/** Directories {@link createTemporaryDirectory} made in this test file (removed after it). */
const created: string[] = []

/**
 * A fresh directory under the OS temp dir, removed after the test file
 * ({@link removeTemporaryDirectories} runs in `afterAll`, tests/jest.afterEnv.ts).
 *
 * @param prefix - Directory name prefix.
 * @returns The directory.
 */
export function createTemporaryDirectory(prefix: string): string {
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix))
  created.push(directory)
  return directory
}

/** Remove every directory {@link createTemporaryDirectory} made so far. */
export function removeTemporaryDirectories(): void {
  created.splice(0).forEach(directory => Fs.rmSync(directory, { recursive: true, force: true }))
}

/** Accessor of the per-test directory registered by {@link useTemporaryDirectory}. */
export type TemporaryDirectory = () => string

/**
 * Give every test of the enclosing `describe` a fresh directory ({@link createTemporaryDirectory}),
 * removed after the test.
 *
 * @param prefix - Directory name prefix.
 * @returns Accessor of the current test's directory.
 */
export function useTemporaryDirectory(prefix: string): TemporaryDirectory {
  let directory: string = null
  beforeEach(() => {
    directory = createTemporaryDirectory(prefix)
  })
  afterEach(() => {
    Fs.rmSync(directory, { recursive: true, force: true })
    directory = null
  })
  return () => directory
}
