import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"

/**
 * A disposable on-disk environment for tests that drive the REAL
 * `ClusterConfigProvider.resolve()` path. `resolveExecutables` fail-fasts on
 * two kinds of binaries, and neither toolchain is installed on the CI runner:
 * - `nodeop`/`kiod`/`clio` must exist under `<buildPath>/bin` — faked there.
 * - `anvil`/`solana-test-validator` must resolve on `PATH` — faked in a
 *   `fake-executables` dir PREPENDED to `process.env.PATH` (with the exec bit
 *   set so the `which` lookup accepts them; the files are never actually run).
 *
 * `WIRE_BIND_REGISTRY_PATH` is also pointed into the temp dir so port claims
 * stay isolated from the host registry.
 */
export interface ResolveEnvironment {
  /** Temp root — write per-test files (bind configs, external configs) here. */
  rootPath: string
  /** Fake build dir whose `bin/` holds empty nodeop/kiod/clio. */
  buildPath: string
  /** Restore `PATH` + `WIRE_BIND_REGISTRY_PATH` and delete `rootPath`. */
  cleanup(): void
}

/** File mode for the fake PATH executables (`which` requires the exec bit). */
const ExecutableMode = 0o755
/** Build-dir binaries `resolveExecutables` expects under `<buildPath>/bin`. */
const BuildExecutables = ["nodeop", "kiod", "clio"] as const
/** Host binaries `resolveExecutables` expects to find on `PATH`. */
const PathExecutables = ["anvil", "solana-test-validator"] as const
/** Fake build dir under the temp root. */
const BuildSubpath = "build"
/** Dir holding the fake PATH executables, prepended to `PATH`. */
const FakeExecutablesSubpath = "fake-executables"
/** Per-test bind-port registry dir (see `BindConfigProvider.registryPath`). */
const RegistrySubpath = "bind-registry"

/**
 * Create the environment. Call from `beforeEach` and pair with
 * `environment.cleanup()` in `afterEach`.
 *
 * @param prefix - Temp-dir prefix naming the suite (e.g. `"bind-config-"`).
 * @returns The created environment.
 */
export function fixtureResolveEnvironment(prefix: string): ResolveEnvironment {
  const previousPath = process.env.PATH,
    previousRegistryPath = process.env.WIRE_BIND_REGISTRY_PATH,
    rootPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix)),
    buildPath = Path.join(rootPath, BuildSubpath),
    // THE `bin` spelling — the same constant `resolveExecutables` joins.
    buildBinPath = Path.join(buildPath, ClusterConfigProvider.BinSubpath),
    fakeExecutablesPath = Path.join(rootPath, FakeExecutablesSubpath)

  process.env.WIRE_BIND_REGISTRY_PATH = Path.join(rootPath, RegistrySubpath)
  Fs.mkdirSync(buildBinPath, { recursive: true })
  BuildExecutables.forEach(bin =>
    Fs.writeFileSync(Path.join(buildBinPath, bin), "")
  )
  Fs.mkdirSync(fakeExecutablesPath, { recursive: true })
  PathExecutables.forEach(bin =>
    Fs.writeFileSync(Path.join(fakeExecutablesPath, bin), "", {
      mode: ExecutableMode
    })
  )
  process.env.PATH = `${fakeExecutablesPath}${Path.delimiter}${previousPath}`

  return {
    rootPath,
    buildPath,
    cleanup() {
      if (previousPath == null) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousRegistryPath == null)
        delete process.env.WIRE_BIND_REGISTRY_PATH
      else process.env.WIRE_BIND_REGISTRY_PATH = previousRegistryPath
      Fs.rmSync(rootPath, { recursive: true, force: true })
    }
  }
}
