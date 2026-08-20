import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  ClusterFiles,
  DefaultChainStateDbSizeMb
} from "@wireio/cluster-tool-shared"
import type { Argv } from "yargs"
import { Constants } from "@wireio/cluster-tool"
import { ClusterCommand } from "@wireio/cluster-tool/cli/ClusterCommand"
import {
  createCreateApiNodeCommand,
  runCreateApiNode,
  toApiNodeOptions,
  type CreateApiNodeArgv
} from "@wireio/cluster-tool/cli/CreateApiNodeCommand"
import { ApiNodeConfig, ApiNodeIniRenderer } from "@wireio/cluster-tool/config"
import { toIniLine } from "@wireio/cluster-tool/utils"

/** A captured `.option()` config — only the fields this suite asserts on. */
interface RecordedOption {
  type?: string
  demandOption?: boolean
  array?: boolean
  default?: unknown
  describe?: string
}

/** The recorder pair returned by {@link createYargsRecorder}. */
interface YargsRecorder {
  argv: Argv
  options: Map<string, RecordedOption>
  parserConfigurations: Parameters<Argv["parserConfiguration"]>[0][]
}

/** A minimal `.option()`-recording `Argv` stand-in (yargs is ESM-only; see
 *  CreateExternalConfigCommand.test.ts / ClusterBuildOptionsArgs.test.ts). */
function createYargsRecorder(): YargsRecorder {
  const options = new Map<string, RecordedOption>(),
    parserConfigurations: Parameters<Argv["parserConfiguration"]>[0][] = [],
    recorder = {
      option(flag: string, config: RecordedOption) {
        options.set(flag, config)
        return recorder
      },
      parserConfiguration(
        configuration: Parameters<Argv["parserConfiguration"]>[0]
      ) {
        parserConfigurations.push(configuration)
        return recorder
      }
    }
  return { argv: recorder as Argv, options, parserConfigurations }
}

/** Record the whole flag surface the builder registers. */
function recordBuilder(): YargsRecorder {
  const recorder = createYargsRecorder()
  createCreateApiNodeCommand().builder(recorder.argv)
  return recorder
}

const HttpServerAddress = "0.0.0.0:8888"

describe("createCreateApiNodeCommand", () => {
  it("names itself with the create-api-node enum member and carries a non-empty describe", () => {
    const module = createCreateApiNodeCommand()
    expect(module.command).toBe(ClusterCommand["create-api-node"])
    expect(
      typeof module.describe === "string" && module.describe.length > 0
    ).toBe(true)
  })

  it("exposes the full yargs command module shape the parser chain registers", () => {
    // `cli/index.ts` self-executes `main()` on import, so the registration
    // contract is asserted through the module's shape rather than by importing
    // the parser (same approach as every sibling command suite).
    const module = createCreateApiNodeCommand()
    expect(typeof module.builder).toBe("function")
    expect(typeof module.handler).toBe("function")
  })

  it("disables boolean-negation so --enable-account-queries stays an explicit flag", () => {
    expect(recordBuilder().parserConfigurations).toEqual([
      { "boolean-negation": false }
    ])
  })

  it("registers the two required string flags", () => {
    const { options } = recordBuilder()
    for (const flag of ["output-path", "http-server-address"]) {
      const option = options.get(flag)
      expect(option).toBeDefined()
      expect(option.type).toBe("string")
      expect(option.demandOption).toBe(true)
    }
  })

  it("registers --p2p-peer-address as a repeatable string array, not demanded", () => {
    const option = recordBuilder().options.get("p2p-peer-address")
    expect(option).toBeDefined()
    expect(option.type).toBe("string")
    expect(option.array).toBe(true)
    expect(option.demandOption).toBeUndefined()
  })

  it("registers every optional tuning flag with its nodeop-aligned name and type", () => {
    const { options } = recordBuilder(),
      expected = new Map<string, string>([
        ["chain-state-db-size-mb", "number"],
        ["transaction-finality-status-max-storage-size-gb", "number"],
        ["enable-account-queries", "boolean"],
        ["http-max-in-flight-requests", "number"],
        ["http-threads", "number"],
        ["agent-name", "string"],
        ["genesis-json", "string"]
      ])
    expected.forEach((type, flag) => {
      const option = options.get(flag)
      expect(option).toBeDefined()
      expect(option.type).toBe(type)
      expect(option.demandOption).toBeUndefined()
    })
  })

  it("registers NOTHING beyond its own ten flags (no shared create surface)", () => {
    const { options } = recordBuilder()
    expect([...options.keys()].sort()).toEqual(
      [
        "agent-name",
        "chain-state-db-size-mb",
        "enable-account-queries",
        "genesis-json",
        "http-max-in-flight-requests",
        "http-server-address",
        "http-threads",
        "output-path",
        "p2p-peer-address",
        "transaction-finality-status-max-storage-size-gb"
      ].sort()
    )
    expect(options.has("build-path")).toBe(false)
    expect(options.has("cluster-path")).toBe(false)
  })

  it("sets NO yargs default — defaults have exactly one home (ApiNodeConfig.resolve)", () => {
    recordBuilder().options.forEach(option =>
      expect(option.default).toBeUndefined()
    )
  })

  it("documents the default value in each optional flag's describe text", () => {
    const { options } = recordBuilder()
    // INTERPOLATED from the resolving constants (NIT-8), never restated — a
    // default change moves the --help text with it.
    expect(
      options.get(Constants.CHAIN_STATE_DB_SIZE_MB_OPTION).describe
    ).toContain(String(DefaultChainStateDbSizeMb))
    expect(
      options.get(ApiNodeIniRenderer.HttpThreadsOption).describe
    ).toContain(String(ApiNodeConfig.DefaultHttpThreads))
    expect(
      options.get(ApiNodeIniRenderer.HttpMaxInFlightRequestsOption).describe
    ).toContain(String(ApiNodeConfig.DefaultHttpMaxInFlightRequests))
    expect(options.get(ApiNodeIniRenderer.AgentNameOption).describe).toContain(
      ApiNodeConfig.DefaultAgentName
    )
    expect(
      options.get(
        ApiNodeIniRenderer.TransactionFinalityStatusMaxStorageSizeGbOption
      ).describe
    ).toContain(
      String(ApiNodeConfig.DefaultTransactionFinalityStatusMaxStorageSizeGb)
    )
    expect(
      options.get(ApiNodeIniRenderer.EnableAccountQueriesOption).describe
    ).toContain(`--${ApiNodeIniRenderer.EnableAccountQueriesOption}=false`)
  })

  it("takes every ini-backed flag NAME from the renderer's option constants", () => {
    // MINOR-9: one spelling per nodeop option, so a flag and the ini key it
    // produces cannot drift apart.
    const { options } = recordBuilder()
    ;[
      ApiNodeIniRenderer.HttpServerAddressOption,
      ApiNodeIniRenderer.P2pPeerAddressOption,
      ApiNodeIniRenderer.TransactionFinalityStatusMaxStorageSizeGbOption,
      ApiNodeIniRenderer.EnableAccountQueriesOption,
      ApiNodeIniRenderer.HttpMaxInFlightRequestsOption,
      ApiNodeIniRenderer.HttpThreadsOption,
      ApiNodeIniRenderer.AgentNameOption,
      Constants.CHAIN_STATE_DB_SIZE_MB_OPTION
    ].forEach(option => expect(options.has(option)).toBe(true))
  })
})

describe("toApiNodeOptions", () => {
  it("nests the tuning leaves into their own group", () => {
    const argv: CreateApiNodeArgv = {
      outputPath: "/tmp/out",
      httpServerAddress: HttpServerAddress,
      p2pPeerAddress: ["10.0.0.5:9876"],
      chainStateDbSizeMb: 8_192,
      transactionFinalityStatusMaxStorageSizeGb: 25,
      enableAccountQueries: false,
      httpMaxInFlightRequests: 500,
      httpThreads: 16,
      agentName: "custom-api",
      genesisJson: "/tmp/genesis.json"
    }
    expect(toApiNodeOptions(argv)).toEqual({
      outputPath: "/tmp/out",
      httpServerAddress: HttpServerAddress,
      p2pPeerAddresses: ["10.0.0.5:9876"],
      chainStateDbSizeMb: 8_192,
      genesisJsonFile: "/tmp/genesis.json",
      tuning: {
        transactionFinalityStatusMaxStorageSizeGb: 25,
        enableAccountQueries: false,
        httpMaxInFlightRequests: 500,
        httpThreads: 16,
        agentName: "custom-api"
      }
    })
  })

  it("leaves an omitted flag undefined so resolve supplies its default", () => {
    const options = toApiNodeOptions({
      outputPath: "/tmp/out",
      httpServerAddress: HttpServerAddress
    })
    expect(options.chainStateDbSizeMb).toBeUndefined()
    expect(options.genesisJsonFile).toBeUndefined()
    expect(options.tuning.httpThreads).toBeUndefined()
    expect(ApiNodeConfig.resolve(options).tuning.httpThreads).toBe(
      ApiNodeConfig.DefaultHttpThreads
    )
  })
})

describe("runCreateApiNode", () => {
  let dir: string

  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "create-api-node-"))
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("creates the output directory and writes config.ini + start.sh", () => {
    const outputPath = Path.join(dir, "fresh", "nested"),
      result = runCreateApiNode({
        outputPath,
        httpServerAddress: HttpServerAddress
      })

    expect(result.configFile).toBe(
      Path.join(outputPath, ClusterFiles.NodeConfigFilename)
    )
    expect(result.startScriptFile).toBe(Path.join(outputPath, "start.sh"))
    expect(Fs.existsSync(result.configFile)).toBe(true)
    expect(Fs.existsSync(result.startScriptFile)).toBe(true)
    // nodeop creates its own --data-dir on first start.
    expect(Fs.existsSync(Path.join(outputPath, "data"))).toBe(false)
  })

  it("writes the ini the renderer produced, carrying the supplied endpoint + peers", () => {
    const outputPath = Path.join(dir, "ini"),
      result = runCreateApiNode({
        outputPath,
        httpServerAddress: "10.0.0.5:9999",
        p2pPeerAddresses: ["10.0.0.6:9876", "10.0.0.7:9876"]
      }),
      ini = Fs.readFileSync(result.configFile, "utf-8")
    expect(ini).toContain("http-server-address = 10.0.0.5:9999")
    expect(ini).toContain("p2p-peer-address = 10.0.0.6:9876")
    expect(ini).toContain("p2p-peer-address = 10.0.0.7:9876")
    expect(ini).toContain(
      toIniLine(ApiNodeIniRenderer.PluginOption, Constants.NET_PLUGIN)
    )
    expect(ini).toContain(
      toIniLine(ApiNodeIniRenderer.PluginOption, Constants.TRACE_API_PLUGIN)
    )
  })

  it("emits start.sh mode 0755 so a consumer runs ./start.sh", () => {
    const result = runCreateApiNode({
      outputPath: Path.join(dir, "mode"),
      httpServerAddress: HttpServerAddress
    })
    expect(Fs.statSync(result.startScriptFile).mode & 0o777).toBe(0o755)
  })

  it("re-emits over an existing tree, keeping start.sh executable", () => {
    const outputPath = Path.join(dir, "reemit"),
      options = { outputPath, httpServerAddress: HttpServerAddress }
    runCreateApiNode(options)
    // writeFileSync's `mode` applies only when it CREATES the file, so the
    // second pass proves the explicit chmod is doing the work.
    const result = runCreateApiNode(options)
    expect(Fs.statSync(result.startScriptFile).mode & 0o777).toBe(0o755)
  })

  it("copies the genesis beside the script and reports its path", () => {
    const genesisJsonFile = Path.join(dir, "source-genesis.json"),
      body = JSON.stringify({ initial_key: "WIRE_TEST" })
    Fs.writeFileSync(genesisJsonFile, body)

    const outputPath = Path.join(dir, "genesis"),
      result = runCreateApiNode({
        outputPath,
        httpServerAddress: HttpServerAddress,
        genesisJsonFile
      })
    expect(result.genesisFile).toBe(Path.join(outputPath, "genesis.json"))
    expect(Fs.readFileSync(result.genesisFile, "utf-8")).toBe(body)
    expect(Fs.readFileSync(result.startScriptFile, "utf-8")).toContain(
      "--genesis-json"
    )
  })

  it("reports no genesis file (and emits no --genesis-json) when none was supplied", () => {
    const result = runCreateApiNode({
      outputPath: Path.join(dir, "no-genesis"),
      httpServerAddress: HttpServerAddress
    })
    expect(result.genesisFile).toBeUndefined()
    expect(Fs.readFileSync(result.startScriptFile, "utf-8")).not.toContain(
      "--genesis-json"
    )
  })

  it("propagates a resolve assertion INSTEAD of writing anything", () => {
    const outputPath = Path.join(dir, "invalid")
    expect(() =>
      runCreateApiNode({ outputPath, httpServerAddress: "0.0.0.0" })
    ).toThrow(/httpServerAddress must be <address>:<port>/)
    expect(Fs.existsSync(outputPath)).toBe(false)
  })
})

describe("createCreateApiNodeCommand handler (end to end)", () => {
  let dir: string

  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "create-api-node-handler-"))
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("drives runCreateApiNode from the parsed argv and exits 0", async () => {
    // The handler is the ONE piece the extracted-function suites above cannot
    // reach: it maps argv → options, emits, and exits. `process.exit` is
    // stubbed because the real one would tear the worker down mid-suite.
    const outputPath = Path.join(dir, "handled"),
      exitSpy = jest
        .spyOn(process, "exit")
        // `never`-returning by type; the stub deliberately returns instead so
        // the handler's remaining statements (there are none) stay reachable.
        .mockImplementation((() => undefined) as never)
    try {
      await createCreateApiNodeCommand().handler({
        outputPath,
        httpServerAddress: HttpServerAddress,
        p2pPeerAddress: ["10.0.0.6:9876"],
        httpThreads: 16
      })
      const configFile = Path.join(outputPath, ClusterFiles.NodeConfigFilename),
        startScriptFile = Path.join(outputPath, "start.sh")
      expect(Fs.existsSync(configFile)).toBe(true)
      expect(Fs.existsSync(startScriptFile)).toBe(true)
      // The argv actually reached the resolver: a nested tuning flag and a
      // repeatable peer both survive the mapping.
      const ini = Fs.readFileSync(configFile, "utf-8")
      expect(ini).toContain(toIniLine(ApiNodeIniRenderer.HttpThreadsOption, 16))
      expect(ini).toContain(
        toIniLine(ApiNodeIniRenderer.P2pPeerAddressOption, "10.0.0.6:9876")
      )
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      exitSpy.mockRestore()
    }
  })
})
