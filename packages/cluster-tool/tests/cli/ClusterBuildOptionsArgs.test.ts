import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { Argv } from "yargs"
import { AWSAccountName, SignatureProviderType } from "@wireio/cluster-tool-shared"
import {
  applyClusterBuildOptionsArgs,
  AWSClusterNodeConfigFlag,
  buildOptionShape,
  ClusterBuildOptionsFileFlag,
  ClusterPathFlag,
  environmentPathDefaults,
  flattenOptionLeaves,
  hasCommandLineFlag,
  loadClusterBuildOptionsFile,
  mergeAWSClusterNodeConfig,
  mergeSignatureProviderSSM,
  OptionLeafType,
  readCommandLineFlag,
  toAWSClusterNodeConfig,
  toClusterBuildOptions,
  toAWSSSMSignatureProviderOptions,
  toFlag,
  type OptionLeaf
} from "@wireio/cluster-tool/cli/ClusterBuildOptionsArgs"

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

/** A minimal `Argv` stand-in paired with the registrations it captured. */
interface YargsRecorder {
  /** The `Argv`-typed facade handed to `applyClusterBuildOptionsArgs`. */
  readonly argv: Argv
  /** Every `.option(flag, config)` registration, keyed by flag. */
  readonly options: Map<string, RecordedOption>
}

/** A minimal `Argv` stand-in that records every `.option(flag, config)` call. */
function createYargsRecorder(): YargsRecorder {
  const options = new Map<string, RecordedOption>(),
    recorder = {
      option(flag: string, config: RecordedOption) {
        options.set(flag, config)
        return recorder
      }
    }
  return { argv: recorder as Argv, options }
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
        "ethereum-bootstrap-json-file",
        "solana-bootstrap-json-file",
        "epoch-duration-sec",
        "force",
        "bind-all",
        "enable-mock-reserves",
        "chain-state-db-size-mb",
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
    register().forEach(config =>
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

  it("registers --chain-state-db-size-mb with NO seeded default (SHARED-31)", () => {
    // An `optionalLeaf`, deliberately: a seeded default would make yargs ALWAYS
    // supply a value, so ClusterConfigProvider.resolve's
    // `?? DefaultChainStateDbSizeMb` would become unreachable dead code and the
    // 1024 fallback would gain a second author.
    const registered = register(RequiredPaths).get("chain-state-db-size-mb")
    expect(registered).toMatchObject({ type: "number", demandOption: false })
    expect(registered?.default).toBeUndefined()
    expect(registered?.describe).toContain("MiB")
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
    const options = register(
      { clusterPath: "/tmp/scenario-cluster" },
      environment
    )
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
    expect(options.requiredBatchOperatorCollateral).toEqual(
      requiredBatchOperatorCollateral
    )
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

  it("preserves bootstrap inputs until the config provider resolves them", () => {
    const options = toClusterBuildOptions({
      "ethereum-bootstrap-json-file": "inputs/ethereum.json",
      "solana-bootstrap-json-file": "inputs/solana.json"
    })
    expect(options.ethereum?.bootstrapJsonFile).toBe("inputs/ethereum.json")
    expect(options.solana?.bootstrapJsonFile).toBe("inputs/solana.json")
  })

  it("coerces boolean flags", () => {
    expect(toClusterBuildOptions({ "bind-all": true }).bindAll).toBe(true)
    expect(toClusterBuildOptions({ "bind-all": false }).bindAll).toBe(false)
    expect(
      toClusterBuildOptions({ "enable-mock-reserves": true }).enableMockReserves
    ).toBe(true)
    expect(
      toClusterBuildOptions({ "enable-mock-reserves": false })
        .enableMockReserves
    ).toBe(false)
  })

  it("reads --chain-state-db-size-mb, and leaves it ABSENT when omitted", () => {
    // Registration is MANDATORY: this reverse parse reads argv ONLY through
    // flattenOptionLeaves(buildOptionShape(...)), so an unregistered field is
    // silently dropped here and never reaches the resolved config.
    expect(
      toClusterBuildOptions({ "chain-state-db-size-mb": 2048 })
        .chainStateDbSizeMb
    ).toBe(2048)
    // Absent ⇒ ClusterConfigProvider.resolve's DefaultChainStateDbSizeMb applies.
    expect(toClusterBuildOptions({}).chainStateDbSizeMb).toBeUndefined()
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
    // no opt-in ⇒ the default-false mock-reserves flag survives as false
    expect(options.enableMockReserves).toBe(false)
    // unseeded (null-default) bind ports never materialize
    expect(options.bind?.kiod?.port).toBeUndefined()
    // …and neither does the unseeded chain-state DB size (SHARED-31) — the
    // resolve-time default is its ONE author.
    expect(options.chainStateDbSizeMb).toBeUndefined()
  })

  it("carries the epoch-group + termination overrides through the full defaults→argv→options round-trip", () => {
    // The slashing-flow shape: scenario defaults set the epoch-group + termination
    // overrides; they MUST survive registration → the defaulted argv → the reverse
    // parse. A field absent from buildOptionShape is silently dropped on this path
    // — the exact gap this guards (batchOpGroups reached ClusterBuildOptions but
    // never the config until it was registered as a shape leaf).
    const registered = register({
        ...RequiredPaths,
        operatorsPerEpoch: 3,
        batchOpGroups: 1,
        epochRetentionEnvelopeLogCount: 200,
        terminateMaxConsecutiveMisses: 5,
        terminateMaxPercentMisses24h: 99,
        terminateWindowMs: 3_600_000,
        enableMockReserves: true,
        chainStateDbSizeMb: 8_192
      }),
      argv: Record<string, unknown> = {}
    registered.forEach((config, flag) => {
      argv[flag] = config.default
    })

    const options = toClusterBuildOptions(argv)
    expect(options.operatorsPerEpoch).toBe(3)
    expect(options.batchOpGroups).toBe(1)
    expect(options.epochRetentionEnvelopeLogCount).toBe(200)
    expect(options.terminateMaxConsecutiveMisses).toBe(5)
    expect(options.terminateMaxPercentMisses24h).toBe(99)
    expect(options.terminateWindowMs).toBe(3_600_000)
    // the scenario-defaults opt-in path the 6 reserve-needing flows rely on
    expect(options.enableMockReserves).toBe(true)
    // the same scenario-defaults path carries the SHARED-31 override
    expect(options.chainStateDbSizeMb).toBe(8_192)
  })
})

const SecretIdPattern = "/wire/{cluster}/{account}/{keyType}"
const SSMJson = `{"awsSecretIdPattern":"${SecretIdPattern}"}`
const SSMFlag = "signature-provider-ssm"

describe("toAWSSSMSignatureProviderOptions", () => {
  it("parses inline JSON (regions are DERIVED, never authored here)", () => {
    const ssm = toAWSSSMSignatureProviderOptions({ [SSMFlag]: SSMJson })
    expect(ssm?.awsSecretIdPattern).toBe(SecretIdPattern)
    expect(ssm?.awsRegions).toBeUndefined()
  })

  it("parses the OPTIONAL version token value", () => {
    const ssm = toAWSSSMSignatureProviderOptions({
      [SSMFlag]: `{"awsSecretIdPattern":"${SecretIdPattern}/{version}","version":"v3"}`
    })
    expect(ssm?.version).toBe("v3")
  })

  it("parses a file path", () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "ssm-opts-")),
      file = Path.join(dir, "ssm.json")
    Fs.writeFileSync(file, SSMJson)
    try {
      expect(
        toAWSSSMSignatureProviderOptions({ [SSMFlag]: file })
          ?.awsSecretIdPattern
      ).toBe(SecretIdPattern)
    } finally {
      Fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns null when the flag is absent", () => {
    expect(toAWSSSMSignatureProviderOptions({})).toBeNull()
  })

  it("throws on a malformed SSM payload (missing awsSecretIdPattern)", () => {
    expect(() =>
      toAWSSSMSignatureProviderOptions({
        [SSMFlag]: '{"awsRegions":["us-east-1"]}'
      })
    ).toThrow()
  })
})

describe("mergeSignatureProviderSSM", () => {
  it("is a no-op when no source carries settings", () => {
    const options = { signatureProvider: { type: SignatureProviderType.SSM } }
    expect(
      mergeSignatureProviderSSM(options, {}).signatureProvider?.ssm
    ).toBeUndefined()
  })

  it("merges the SSM payload into signatureProvider.ssm", () => {
    const options = { signatureProvider: { type: SignatureProviderType.SSM } },
      merged = mergeSignatureProviderSSM(options, { [SSMFlag]: SSMJson })
    expect(merged.signatureProvider?.ssm?.awsSecretIdPattern).toBe(
      SecretIdPattern
    )
  })

  it("falls back to the options-file document's signatureProvider.ssm", () => {
    const merged = mergeSignatureProviderSSM({}, {}, {
      signatureProvider: {
        ssm: { awsSecretIdPattern: "/from/{cluster}/{account}/{keyType}" }
      }
    })
    expect(merged.signatureProvider?.ssm?.awsSecretIdPattern).toBe(
      "/from/{cluster}/{account}/{keyType}"
    )
  })

  it("falls back LAST to the awsClusterNodeConfig's own ssm", () => {
    const merged = mergeSignatureProviderSSM(
      {
        awsClusterNodeConfig: {
          account: AWSAccountName.dev,
          regions: ["us-east-1"],
          ssm: { awsSecretIdPattern: "/node-config/{account}/{keyType}" }
        }
      },
      {}
    )
    expect(merged.signatureProvider?.ssm?.awsSecretIdPattern).toBe(
      "/node-config/{account}/{keyType}"
    )
  })

  it("prefers the flag over the file, and the file over the node config", () => {
    const fileOptions = {
        signatureProvider: { ssm: { awsSecretIdPattern: "/file/{account}" } }
      },
      nodeConfigOptions = {
        awsClusterNodeConfig: {
          account: AWSAccountName.dev,
          regions: ["us-east-1"],
          ssm: { awsSecretIdPattern: "/node-config/{account}" }
        }
      }
    expect(
      mergeSignatureProviderSSM(
        { ...nodeConfigOptions },
        { [SSMFlag]: SSMJson },
        fileOptions
      ).signatureProvider?.ssm?.awsSecretIdPattern
    ).toBe(SecretIdPattern)
    expect(
      mergeSignatureProviderSSM({ ...nodeConfigOptions }, {}, fileOptions)
        .signatureProvider?.ssm?.awsSecretIdPattern
    ).toBe("/file/{account}")
  })
})

describe("raw command-line reads", () => {
  it("readCommandLineFlag reads both `--flag value` and `--flag=value`", () => {
    expect(
      readCommandLineFlag(["create", "--cluster-path", "/tmp/a"], ClusterPathFlag)
    ).toBe("/tmp/a")
    expect(
      readCommandLineFlag(["create", "--cluster-path=/tmp/b"], ClusterPathFlag)
    ).toBe("/tmp/b")
  })

  it("readCommandLineFlag returns null when the flag is absent", () => {
    expect(readCommandLineFlag(["create", "-d", "/tmp/a"], ClusterPathFlag)).toBeNull()
  })

  it("hasCommandLineFlag sees the long form, the `=` form, and the short alias", () => {
    expect(hasCommandLineFlag(["--cluster-path", "/x"], ClusterPathFlag)).toBe(true)
    expect(hasCommandLineFlag(["--cluster-path=/x"], ClusterPathFlag)).toBe(true)
    expect(hasCommandLineFlag(["-d", "/x"], ClusterPathFlag)).toBe(true)
    expect(hasCommandLineFlag(["-d=/x"], ClusterPathFlag)).toBe(true)
  })

  it("hasCommandLineFlag is false for a flag that only arrives as a yargs default", () => {
    expect(hasCommandLineFlag(["create", "--force"], ClusterPathFlag)).toBe(false)
  })
})

describe("--cluster-build-options-file", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "build-options-"))
  })

  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Write `document` to a temp file and return its path. */
  function writeDocument(document: unknown): string {
    const file = Path.join(dir, "cluster-build-options.json")
    Fs.writeFileSync(file, JSON.stringify(document))
    return file
  }

  it("is registered as an out-of-shape string option (so --strict accepts it)", () => {
    const options = register()
    expect(options.get(ClusterBuildOptionsFileFlag)).toMatchObject({
      type: "string"
    })
    expect(options.get(AWSClusterNodeConfigFlag)).toMatchObject({
      type: "string"
    })
  })

  it("loads scalar leaves at every depth, re-nested", () => {
    const loaded = loadClusterBuildOptionsFile(
      writeDocument({
        clusterPath: "/tmp/doc-cluster",
        epochDurationSec: 30,
        bindAll: true,
        bind: { kiod: { port: 1234 }, nodeop: { ports: { bios: { http: 5555 } } } },
        logging: { levels: { console: "debug" } }
      })
    )
    expect(loaded.clusterPath).toBe("/tmp/doc-cluster")
    expect(loaded.epochDurationSec).toBe(30)
    expect(loaded.bindAll).toBe(true)
    expect(loaded.bind?.kiod?.port).toBe(1234)
    expect(loaded.bind?.nodeop?.ports?.bios?.http).toBe(5555)
    expect(loaded.logging?.levels?.console).toBe("debug")
  })

  it("sizes the bind node-port arrays from the document's own counts", () => {
    const loaded = loadClusterBuildOptionsFile(
      writeDocument({
        nodeCount: 2,
        bind: { nodeop: { ports: { producers: [{ http: 7000 }, { http: 7001 }] } } }
      })
    )
    expect(loaded.bind?.nodeop?.ports?.producers?.[1]?.http).toBe(7001)
  })

  it("carries the flag-less collateral arrays through their shared schemas", () => {
    const loaded = loadClusterBuildOptionsFile(
      writeDocument({
        requiredBatchOperatorCollateral: [
          { chainCode: 11, tokenCode: 22, minimumBond: 2_000_000 }
        ]
      })
    )
    expect(loaded.requiredBatchOperatorCollateral).toEqual([
      { chainCode: 11, tokenCode: 22, minimumBond: 2_000_000 }
    ])
  })

  it("codec-validates the out-of-shape signatureProvider.ssm", () => {
    const loaded = loadClusterBuildOptionsFile(
      writeDocument({
        signatureProvider: {
          type: SignatureProviderType.SSM,
          ssm: { awsSecretIdPattern: SecretIdPattern }
        }
      })
    )
    expect(loaded.signatureProvider?.type).toBe(SignatureProviderType.SSM)
    expect(loaded.signatureProvider?.ssm?.awsSecretIdPattern).toBe(SecretIdPattern)
  })

  it("rejects an unknown option, naming its dotted path", () => {
    expect(() =>
      loadClusterBuildOptionsFile(writeDocument({ bind: { kiod: { prot: 1 } } }))
    ).toThrow(/unknown option "bind\.kiod\.prot"/)
    expect(() =>
      loadClusterBuildOptionsFile(writeDocument({ nope: 1 }))
    ).toThrow(/unknown option "nope"/)
  })

  it("rejects a wrongly-typed leaf, naming its dotted path and the expected type", () => {
    expect(() =>
      loadClusterBuildOptionsFile(writeDocument({ epochDurationSec: "60" }))
    ).toThrow(/"epochDurationSec" must be a number/)
    expect(() =>
      loadClusterBuildOptionsFile(writeDocument({ force: {} }))
    ).toThrow(/"force" must be a boolean/)
  })

  it("rejects a value outside a choices-constrained leaf", () => {
    expect(() =>
      loadClusterBuildOptionsFile(
        writeDocument({ signatureProvider: { type: "VAULT" } })
      )
    ).toThrow(/"signatureProvider\.type" must be one of/)
  })

  it("rejects awsClusterNodeConfig, pointing at its own flag", () => {
    expect(() =>
      loadClusterBuildOptionsFile(
        writeDocument({ awsClusterNodeConfig: { account: "dev", regions: ["us-east-1"] } })
      )
    ).toThrow(new RegExp(`--${AWSClusterNodeConfigFlag}`))
  })

  it("rejects a non-object document root and invalid JSON", () => {
    expect(() => loadClusterBuildOptionsFile(writeDocument([1, 2]))).toThrow(
      /document root must be a JSON object/
    )
    const badFile = Path.join(dir, "bad.json")
    Fs.writeFileSync(badFile, "{not json")
    expect(() => loadClusterBuildOptionsFile(badFile)).toThrow(
      /could not be read as JSON/
    )
  })

  it("rejects a non-integer topology count before the shape is built", () => {
    expect(() =>
      loadClusterBuildOptionsFile(writeDocument({ nodeCount: 1.5 }))
    ).toThrow(/"nodeCount" must be a non-negative integer/)
  })
})

describe("--aws-cluster-node-config", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "aws-node-config-"))
  })

  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Write an `AWSClusterNodeConfig` document and return its path. */
  function writeNodeConfig(document: unknown): string {
    const file = Path.join(dir, "aws-cluster-node-config.json")
    Fs.writeFileSync(file, JSON.stringify(document))
    return file
  }

  it("returns null when the flag is absent", () => {
    expect(toAWSClusterNodeConfig({})).toBeNull()
  })

  it("deserializes the file through the shared AWSClusterNodeConfig codec", () => {
    const file = writeNodeConfig({
      account: AWSAccountName.dev,
      regions: ["us-east-1", "eu-west-1"]
    })
    const config = toAWSClusterNodeConfig({ [AWSClusterNodeConfigFlag]: file })
    expect(config?.account).toBe(AWSAccountName.dev)
    expect(config?.regions).toEqual(["us-east-1", "eu-west-1"])
    // schema default — the slot round-trips through JSON as an explicit null
    expect(config?.ssm).toBeNull()
  })

  it("throws on a malformed node config (no regions)", () => {
    const file = writeNodeConfig({ account: AWSAccountName.dev, regions: [] })
    expect(() =>
      toAWSClusterNodeConfig({ [AWSClusterNodeConfigFlag]: file })
    ).toThrow()
  })

  it("mergeAWSClusterNodeConfig fills options.awsClusterNodeConfig (no-op when absent)", () => {
    const file = writeNodeConfig({
      account: AWSAccountName.test,
      regions: ["us-east-1"]
    })
    expect(
      mergeAWSClusterNodeConfig({}, { [AWSClusterNodeConfigFlag]: file })
        .awsClusterNodeConfig?.account
    ).toBe(AWSAccountName.test)
    expect(mergeAWSClusterNodeConfig({}, {}).awsClusterNodeConfig).toBeUndefined()
  })
})
