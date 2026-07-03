import Path from "node:path"
import type { Argv } from "yargs"
import {
  applyClusterBuildOptionsArgs,
  buildOptionShape,
  environmentPathDefaults,
  flattenOptionLeaves,
  OptionLeafType,
  toClusterBuildOptions,
  toFlag,
  type OptionLeaf
} from "@wireio/test-cluster-tool/cli/ClusterBuildOptionsArgs"

// `yargs` is ESM-only as of v18 and jest's CJS runtime can't load it (see
// debugging-client-tool-tui/tests/cli.test.ts). The design under test needs no
// real yargs: registration is exercised via a `.option()` recorder, and the
// reverse parse is fed a hand-built argv (exactly the flat `Record` yargs yields).

/** One captured `.option(flag, config)` registration. */
interface RecordedOption {
  type?: string
  describe?: string
  default?: unknown
  demandOption?: boolean
  alias?: string
}

/** A minimal `Argv` stand-in that records every `.option(flag, config)` call. */
function createYargsRecorder(): {
  argv: Argv
  options: Map<string, RecordedOption>
} {
  const options = new Map<string, RecordedOption>(),
    recorder = {
      option(flag: string, config: RecordedOption) {
        options.set(flag, config)
        return recorder
      }
    }
  return { argv: recorder as unknown as Argv, options }
}

/**
 * Register `defaults` onto a fresh recorder and return the captured option map.
 * `environment` defaults EMPTY so a developer shell's `WIRE_*` exports can never
 * leak into the deterministic registration assertions.
 */
function register(
  defaults = {},
  environment: NodeJS.ProcessEnv = {}
): Map<string, RecordedOption> {
  const { argv, options } = createYargsRecorder()
  applyClusterBuildOptionsArgs(argv, defaults, environment)
  return options
}

/** Look one flattened leaf up by its kebab flag (throws if absent). */
function leafByFlag(leaves: OptionLeaf[], flag: string): OptionLeaf {
  const found = leaves.find(leaf => leaf.flag === flag)
  if (!found) {
    throw new Error(`no leaf for flag: ${flag}`)
  }
  return found
}

/** The four always-required roots. */
const RequiredPaths = {
  clusterPath: "/tmp/wire-cluster",
  buildPath: "/tmp/wire-build",
  ethereumPath: "/tmp/wire-eth",
  solanaPath: "/tmp/wire-sol"
}

describe("toFlag", () => {
  it("kebab-cases each dotted segment and joins with '-'", () => {
    expect(toFlag(["bind", "kiod", "port"])).toBe("bind-kiod-port")
    expect(toFlag(["epochDurationSec"])).toBe("epoch-duration-sec")
    expect(toFlag(["bind", "nodeop", "ports", "bios", "http"])).toBe(
      "bind-nodeop-ports-bios-http"
    )
    expect(toFlag(["bind", "debuggingServer", "port"])).toBe(
      "bind-debugging-server-port"
    )
  })

  it("passes numeric array-index segments through unchanged", () => {
    expect(toFlag(["bind", "nodeop", "ports", "producers", "0", "http"])).toBe(
      "bind-nodeop-ports-producers-0-http"
    )
  })

  it("keeps letter↔digit boundaries intact (p2p, not p-2-p)", () => {
    expect(toFlag(["bind", "nodeop", "ports", "bios", "p2p"])).toBe(
      "bind-nodeop-ports-bios-p2p"
    )
    expect(toFlag(["terminateWindowMs"])).toBe("terminate-window-ms")
  })
})

describe("flattenOptionLeaves + buildOptionShape", () => {
  it("emits a kebab flag for every leaf at any depth", () => {
    const flags = flattenOptionLeaves(buildOptionShape({})).map(
      leaf => leaf.flag
    )
    expect(flags).toEqual(
      expect.arrayContaining([
        "cluster-path",
        "build-path",
        "epoch-duration-sec",
        "force",
        "bind-all",
        "bind-kiod-port",
        "bind-kiod-address",
        "bind-nodeop-ports-bios-http",
        "bind-nodeop-ports-bios-p2p",
        "bind-nodeop-ports-producers-0-http",
        "bind-solana-ports-faucet",
        "bind-debugging-server-port",
        "logging-levels-console",
        "logging-file-format"
      ])
    )
  })

  it("infers the yargs type from each leaf's default value", () => {
    const leaves = flattenOptionLeaves(buildOptionShape({}))
    expect(leafByFlag(leaves, "epoch-duration-sec").type).toBe(
      OptionLeafType.number
    )
    expect(leafByFlag(leaves, "force").type).toBe(OptionLeafType.boolean)
    expect(leafByFlag(leaves, "logging-levels-console").type).toBe(
      OptionLeafType.string
    )
    // a null-defaulted bind port carries its explicit type
    expect(leafByFlag(leaves, "bind-kiod-port").type).toBe(
      OptionLeafType.number
    )
  })

  it("carries a non-empty describe for every generated flag", () => {
    flattenOptionLeaves(buildOptionShape({})).forEach(leaf =>
      expect(leaf.describe.length).toBeGreaterThan(0)
    )
  })

  it("marks the four root paths required and everything else optional", () => {
    const leaves = flattenOptionLeaves(buildOptionShape({}))
    expect(leafByFlag(leaves, "cluster-path").required).toBe(true)
    expect(leafByFlag(leaves, "build-path").required).toBe(true)
    expect(leafByFlag(leaves, "epoch-duration-sec").required).toBe(false)
    expect(leafByFlag(leaves, "bind-kiod-port").required).toBe(false)
  })

  it("sizes the node-port arrays from the topology counts", () => {
    const flags = flattenOptionLeaves(
      buildOptionShape({ nodeCount: 2, underwriterCount: 2 })
    ).map(leaf => leaf.flag)
    expect(flags).toContain("bind-nodeop-ports-producers-0-http")
    expect(flags).toContain("bind-nodeop-ports-producers-1-http")
    expect(flags).toContain("bind-nodeop-ports-underwriters-1-p2p")
    expect(flags).not.toContain("bind-nodeop-ports-producers-2-http")
  })

  it("yields no flags for empty-by-default arrays (collateral)", () => {
    const flags = flattenOptionLeaves(buildOptionShape({})).map(
      leaf => leaf.flag
    )
    expect(flags.some(flag => flag.startsWith("req-prod-collat"))).toBe(false)
    expect(flags.some(flag => flag.startsWith("underwriter-collateral"))).toBe(
      false
    )
  })
})

describe("applyClusterBuildOptionsArgs registration", () => {
  it("registers a described, typed yargs option for every deep flag", () => {
    const options = register()
    expect(options.get("bind-kiod-port")).toMatchObject({
      type: "number",
      describe: "kiod listen port"
    })
    expect(options.get("bind-nodeop-ports-producers-0-http")).toMatchObject({
      type: "number",
      describe: "producer[0] nodeop http listen port"
    })
    expect(options.get("epoch-duration-sec")).toMatchObject({
      type: "number",
      describe: "minimum epoch duration in seconds"
    })
    expect(options.get("force")).toMatchObject({ type: "boolean" })
    expect(options.get("logging-levels-console")).toMatchObject({
      type: "string"
    })
  })

  it("gives EVERY registered flag a non-empty describe (--help completeness)", () => {
    register().forEach((config, flag) =>
      expect(
        typeof config.describe === "string" && config.describe.length > 0
      ).toBe(true)
    )
  })

  it("demands the four root paths only when a default is not seeded", () => {
    const bare = register()
    expect(bare.get("cluster-path")?.demandOption).toBe(true)
    expect(bare.get("build-path")?.demandOption).toBe(true)

    const seeded = register(RequiredPaths)
    expect(seeded.get("cluster-path")?.demandOption).toBe(false)
    expect(seeded.get("cluster-path")?.default).toBe(RequiredPaths.clusterPath)
  })

  it("seeds a flag default from the passed defaults", () => {
    const options = register({ ...RequiredPaths, epochDurationSec: 42 })
    expect(options.get("epoch-duration-sec")?.default).toBe(42)
  })

  it("wires the historical short aliases", () => {
    const options = register()
    expect(options.get("cluster-path")?.alias).toBe("d")
    expect(options.get("batch-operator-count")?.alias).toBe("b")
  })
})

describe("WIRE_* environment seeding (the run-flow.mjs / e2e-gate contract)", () => {
  const environment: NodeJS.ProcessEnv = {
    WIRE_CLUSTER_PATH: "/tmp/env-cluster",
    WIRE_BUILD_PATH: "/tmp/env-build",
    WIRE_ETH_PATH: "/tmp/env-ethereum",
    WIRE_SOLANA_PATH: "/tmp/env-solana"
  }

  it("environmentPathDefaults maps the four WIRE_* variables (empty ones omitted)", () => {
    expect(environmentPathDefaults(environment)).toEqual({
      clusterPath: "/tmp/env-cluster",
      buildPath: "/tmp/env-build",
      ethereumPath: "/tmp/env-ethereum",
      solanaPath: "/tmp/env-solana"
    })
    expect(environmentPathDefaults({ WIRE_BUILD_PATH: "" })).toEqual({})
    expect(environmentPathDefaults({})).toEqual({})
  })

  it("env-seeded path flags become optional with the env value as default", () => {
    const options = register({}, environment)
    expect(options.get("cluster-path")).toMatchObject({
      demandOption: false,
      default: "/tmp/env-cluster"
    })
    expect(options.get("ethereum-path")).toMatchObject({
      demandOption: false,
      default: "/tmp/env-ethereum"
    })
  })

  it("the environment (per-invocation operator intent) beats scenario defaults", () => {
    const options = register({ clusterPath: "/tmp/scenario-cluster" }, environment)
    expect(options.get("cluster-path")?.default).toBe("/tmp/env-cluster")
  })

  it("scenario defaults still seed leaves the environment does not carry", () => {
    const options = register({ epochDurationSec: 42 }, environment)
    expect(options.get("epoch-duration-sec")?.default).toBe(42)
  })
})

describe("toClusterBuildOptions reverse parse", () => {
  it("re-nests deep + array leaves back into ClusterBuildOptions", () => {
    const options = toClusterBuildOptions({
      "cluster-path": RequiredPaths.clusterPath,
      "build-path": RequiredPaths.buildPath,
      "bind-kiod-port": 1234,
      "epoch-duration-sec": 30,
      "bind-nodeop-ports-bios-http": 5555,
      "bind-nodeop-ports-producers-0-http": 6001
    })

    expect(options.bind?.kiod?.port).toBe(1234)
    expect(options.epochDurationSec).toBe(30)
    expect(options.bind?.nodeop?.ports?.bios?.http).toBe(5555)
    expect(options.bind?.nodeop?.ports?.producers?.[0]?.http).toBe(6001)
  })

  it("sizes reverse array leaves from argv's own counts", () => {
    const options = toClusterBuildOptions({
      "node-count": 2,
      "bind-nodeop-ports-producers-1-http": 7001
    })
    expect(options.bind?.nodeop?.ports?.producers?.[1]?.http).toBe(7001)
  })

  it("carries the NON-FLAG collateral leaves over from the caller defaults", () => {
    const requiredBatchOperatorCollateral = [
      { chainCode: 11, tokenCode: 22, minimumBond: 2_000_000 },
      { chainCode: 33, tokenCode: 44, minimumBond: 2_000_000 }
    ]
    const options = toClusterBuildOptions(
      { "epoch-duration-sec": 60 },
      { requiredBatchOperatorCollateral }
    )
    expect(options.requiredBatchOperatorCollateral).toEqual(requiredBatchOperatorCollateral)
    // absent defaults stay absent — flags never set these leaves
    expect(options.requiredUnderwriterCollateral).toBeUndefined()
  })

  it("absolutizes path leaves and leaves unset bind ports absent", () => {
    const options = toClusterBuildOptions({
      "cluster-path": "relative/cluster",
      "build-path": RequiredPaths.buildPath,
      "bind-kiod-port": 1234
    })
    expect(options.clusterPath).toBe(Path.resolve("relative/cluster"))
    expect(options.buildPath).toBe(Path.resolve(RequiredPaths.buildPath))
    // an override never supplied stays absent → BindConfig auto-picks it
    expect(options.bind?.anvil?.port).toBeUndefined()
  })

  it("coerces boolean flags", () => {
    expect(toClusterBuildOptions({ "bind-all": true }).bindAll).toBe(true)
    expect(toClusterBuildOptions({ "bind-all": false }).bindAll).toBe(false)
  })

  it("reads the camelCase alias yargs also emits", () => {
    // yargs stores both kebab + camelCase; the reverse falls back to camelCase
    expect(
      toClusterBuildOptions({ epochDurationSec: 15 }).epochDurationSec
    ).toBe(15)
  })
})

describe("register → parse round-trip", () => {
  it("every non-required leaf's default survives a parse of the defaulted argv", () => {
    // Simulate yargs producing an argv from ONLY the registered defaults (no
    // user flags): each option's `default` under its flag key.
    const registered = register(RequiredPaths),
      argv: Record<string, unknown> = {}
    registered.forEach((config, flag) => {
      argv[flag] = config.default
    })

    const options = toClusterBuildOptions(argv)
    expect(options.clusterPath).toBe(Path.resolve(RequiredPaths.clusterPath))
    expect(options.epochDurationSec).toBe(60)
    expect(options.nodeCount).toBe(1)
    expect(options.bindAll).toBe(false)
    // unseeded (null-default) bind ports never materialize
    expect(options.bind?.kiod?.port).toBeUndefined()
  })
})
