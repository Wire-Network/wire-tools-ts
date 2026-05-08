import { Level } from "@wireio/shared"

// `yargs` is ESM-only as of v18; jest's CJS runtime can't load it without extensive
// transform plumbing. Mock it for the tests in this file. parseArgs's behavior under
// real yargs is covered by the bundled-binary smoke path.
jest.mock("yargs", () => {
  const chain: any = {}
  const returnChain = () => chain
  ;[
    "scriptName",
    "usage",
    "option",
    "strict",
    "help",
    "parseSync",
    "command",
    "middleware",
    "check"
  ].forEach(name => {
    chain[name] = returnChain
  })
  return { __esModule: true, default: () => chain }
})
jest.mock("yargs/helpers", () => ({
  __esModule: true,
  hideBin: (argv: readonly string[]) => argv.slice(2)
}))

// Imports that pull yargs must come AFTER the mocks are registered.
/* eslint-disable import/first */
import {
  CLI,
  coerceFeatures
} from "@wireio/debugging-client-tool-tui/cli.js"
/* eslint-enable import/first */

describe("coerceFeatures", () => {
  it("returns null for undefined / empty / whitespace-only input", () => {
    expect(coerceFeatures(undefined)).toBeNull()
    expect(coerceFeatures("")).toBeNull()
    expect(coerceFeatures("  ,  ,")).toBeNull()
  })

  it("lowercases and trims every id, drops empties", () => {
    expect(coerceFeatures(" OPP, Process-Monitor ,,")).toEqual(
      new Set(["opp", "process-monitor"])
    )
  })

  it("dedupes via Set semantics", () => {
    expect(coerceFeatures("a,a,b,b,a")).toEqual(new Set(["a", "b"]))
  })
})

describe("CLI namespace constants", () => {
  it("exposes expected option names + aliases", () => {
    expect(CLI.Options.ClusterPathOption).toBe("cluster-path")
    expect(CLI.Options.ClusterPathAlias).toBe("c")
    expect(CLI.Options.ServerUrlOption).toBe("server-url")
    expect(CLI.Options.ServerUrlAlias).toBe("s")
    expect(CLI.Options.FeaturesOption).toBe("features")
    expect(CLI.Options.LogLevelOption).toBe("log-level")
  })

  it("LogLevels lists every shared Level value", () => {
    expect(CLI.LogLevels).toEqual([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal"
    ])
  })

  it("DefaultLogLevel is info", () => {
    expect(CLI.DefaultLogLevel).toBe(Level.info)
  })
})
