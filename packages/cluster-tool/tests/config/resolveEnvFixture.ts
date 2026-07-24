import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

/**
 * A disposable on-disk environment for tests that drive the REAL
 * `ClusterConfigProvider.resolve()` path. `resolveExecutables` fail-fasts on
 * two kinds of binaries, and neither toolchain is installed on the CI runner:
 * - `nodeop`/`kiod`/`clio` must exist under `<buildPath>/bin` — faked there.
 * - `anvil`/`solana-test-validator` must resolve on `PATH` — faked in a
 *   `path-bin` dir PREPENDED to `process.env.PATH` (with the exec bit set so
 *   the `which` lookup accepts them; the files are never actually run).
 *
 * `WIRE_BIND_REGISTRY_PATH` is also pointed into the temp dir so port claims
 * stay isolated from the host registry.
 */
export interface ResolveEnv {
  /** Temp root — write per-test files (bind configs, external configs) here. */
  dir: string
  /** Fake build dir whose `bin/` holds empty nodeop/kiod/clio. */
  buildPath: string
  /** Restore `PATH` + `WIRE_BIND_REGISTRY_PATH` and delete `dir`. */
  cleanup(): void
}

/** File mode for the fake PATH executables (`which` requires the exec bit). */
const ExecutableMode = 0o755
/** Build-dir binaries `resolveExecutables` expects under `<buildPath>/bin`. */
const BuildBinaries = ["nodeop", "kiod", "clio"]
/** Host binaries `resolveExecutables` expects to find on `PATH`. */
const PathBinaries = ["anvil", "solana-test-validator"]

/**
 * Create the environment. Call from `beforeEach` and pair with
 * `env.cleanup()` in `afterEach`.
 *
 * @param prefix - Temp-dir prefix naming the suite (e.g. `"bind-config-"`).
 * @returns The created environment.
 */
export function createResolveEnv(prefix: string): ResolveEnv {
  const previousPath = process.env.PATH,
    previousRegistry = process.env.WIRE_BIND_REGISTRY_PATH,
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix)),
    buildPath = Path.join(dir, "build"),
    buildBin = Path.join(buildPath, "bin"),
    pathBin = Path.join(dir, "path-bin")

  process.env.WIRE_BIND_REGISTRY_PATH = Path.join(dir, "bind-registry")
  Fs.mkdirSync(buildBin, { recursive: true })
  BuildBinaries.forEach(bin => Fs.writeFileSync(Path.join(buildBin, bin), ""))
  Fs.mkdirSync(pathBin, { recursive: true })
  PathBinaries.forEach(bin =>
    Fs.writeFileSync(Path.join(pathBin, bin), "", { mode: ExecutableMode })
  )
  process.env.PATH = `${pathBin}${Path.delimiter}${previousPath}`

  return {
    dir,
    buildPath,
    cleanup() {
      restoreEnv("PATH", previousPath)
      restoreEnv("WIRE_BIND_REGISTRY_PATH", previousRegistry)
      Fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Restore an env var to its pre-fixture value (delete if it was unset). */
function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name]
  else process.env[name] = value
}
