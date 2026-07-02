import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

// Sandbox the cross-process bind-port registry (BindConfig.RegistryPathEnvVar)
// for EVERY suite: unit tests must neither read live flow runs' reservations
// (nondeterministic exclusions) nor write into the real host registry. The env
// var name is spelled literally because importing BindConfig here would
// pre-load it into the per-file module registry ahead of the get-port module
// mock BindConfig.test.ts registers.
process.env.WIRE_BIND_REGISTRY_PATH = Fs.mkdtempSync(
  Path.join(Os.tmpdir(), "wire-bind-registry-test-")
)
