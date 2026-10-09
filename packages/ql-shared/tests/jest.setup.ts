import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

// Sandbox the cross-process bind-port registry (BindConfigProvider.RegistryPathEnvVar)
// for every suite: tests that claim stub-server ports must neither read live
// runs' reservations nor write into the real host registry.
process.env.WIRE_BIND_REGISTRY_PATH = Fs.mkdtempSync(
  Path.join(Os.tmpdir(), "wire-bind-registry-test-")
)
