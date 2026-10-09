import { TempDirectory } from "./common/TempDirectory.js"

// Only BindConfigProvider's own module is loaded (jest's moduleNameMapper resolves
// the source path; the package root would load the whole cluster-tool barrel in
// every suite). Its type is the package root's.
const { BindConfigProvider } = require("@wireio/cluster-tool/config/BindConfigProvider") as typeof import("@wireio/cluster-tool")

// Sandbox the cross-process bind-port registry for every suite: stub-server
// ports are claimed without touching the host registry. The directory is a
// TempDirectory, removed with the suite's others by jest.afterEnv.ts.
process.env[BindConfigProvider.RegistryPathEnvVar] = TempDirectory.create()
