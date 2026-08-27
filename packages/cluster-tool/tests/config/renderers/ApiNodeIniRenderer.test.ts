import { DefaultChainStateDbSizeMb } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool"
import {
  ApiNodeConfig,
  ApiNodeIniRenderer,
  type ApiNodeOptions
} from "@wireio/cluster-tool/config"

/** The output path is never rendered into the ini — any value does. */
const OutputPath = "/tmp/api-node"
const HttpServerAddress = "0.0.0.0:8888"

/** Render the ini for `overrides` merged over the minimum valid options. */
function render(overrides: ApiNodeOptions = {}): string {
  return new ApiNodeIniRenderer(
    ApiNodeConfig.resolve({
      outputPath: OutputPath,
      httpServerAddress: HttpServerAddress,
      ...overrides
    })
  ).render()
}

describe("ApiNodeIniRenderer", () => {
  it("renders the exact ticket-baseline ini for a defaults-only config", () => {
    expect(render()).toBe(
      [
        `chain-state-db-size-mb = ${DefaultChainStateDbSizeMb}`,
        "transaction-finality-status-max-storage-size-gb = 10",
        "enable-account-queries = true",
        "http-max-in-flight-requests = 100",
        "http-threads = 4",
        "agent-name = wire-api-node",
        `http-server-address = ${HttpServerAddress}`,
        "",
        "plugin = sysio::net_plugin",
        "plugin = sysio::chain_api_plugin",
        "plugin = sysio::trace_api_plugin",
        ""
      ].join("\n")
    )
  })

  it("carries the http-server-address VERBATIM (no port-registry rewrite)", () => {
    expect(render({ httpServerAddress: "10.0.0.5:9999" })).toContain(
      "http-server-address = 10.0.0.5:9999"
    )
  })

  it("renders the chain-state-db-size-mb override", () => {
    expect(render({ chainStateDbSizeMb: 8_192 })).toContain(
      "chain-state-db-size-mb = 8192"
    )
  })

  it("renders ONE p2p-peer-address line per entry, in order", () => {
    const lines = render({
      p2pPeerAddresses: ["10.0.0.5:9876", "10.0.0.6:9876", "10.0.0.7:9876"]
    })
      .split("\n")
      .filter(line => line.startsWith("p2p-peer-address"))
    expect(lines).toEqual([
      "p2p-peer-address = 10.0.0.5:9876",
      "p2p-peer-address = 10.0.0.6:9876",
      "p2p-peer-address = 10.0.0.7:9876"
    ])
  })

  it("emits NO p2p-peer-address line when there are no peers", () => {
    expect(render()).not.toContain("p2p-peer-address")
  })

  it("renders every tuning override", () => {
    const ini = render({
      tuning: {
        transactionFinalityStatusMaxStorageSizeGb: 25,
        enableAccountQueries: false,
        httpMaxInFlightRequests: 500,
        httpThreads: 16,
        agentName: "custom-api"
      }
    })
    expect(ini).toContain(
      "transaction-finality-status-max-storage-size-gb = 25"
    )
    expect(ini).toContain("enable-account-queries = false")
    expect(ini).toContain("http-max-in-flight-requests = 500")
    expect(ini).toContain("http-threads = 16")
    expect(ini).toContain("agent-name = custom-api")
  })

  it("loads chain_api_plugin, trace_api_plugin AND net_plugin", () => {
    const plugins = render()
      .split("\n")
      .filter(line => line.startsWith("plugin = "))
      .map(line => line.replace("plugin = ", ""))
    expect(plugins).toEqual([...ApiNodeIniRenderer.Plugins])
    expect(plugins).toContain("sysio::chain_api_plugin")
    expect(plugins).toContain(Constants.TRACE_API_PLUGIN)
    // net_plugin is the DELIBERATE addition to the ticket baseline: it owns the
    // `p2p-peer-address` AND `agent-name` options, which would otherwise be
    // accepted-and-ignored (appbase registers options for every compiled-in
    // plugin) and the node would never sync.
    expect(plugins).toContain("sysio::net_plugin")
  })

  it("composes its plugin set from the INDIVIDUAL shared constants, not BASE_PLUGINS", () => {
    // Deliberately decoupled from the cluster's base set (NIT-1): the two
    // coincide today, but a future cluster-wide base plugin must NOT silently
    // reach a standalone API node's config.ini — while the strings themselves
    // are still never re-spelled here.
    expect(ApiNodeIniRenderer.Plugins).toEqual([
      Constants.NET_PLUGIN,
      Constants.CHAIN_API_PLUGIN,
      Constants.TRACE_API_PLUGIN
    ])
  })

  it("takes every ini KEY from a named constant (no inline option spellings)", () => {
    // MINOR-9: the same constants CreateApiNodeCommand registers its flags
    // from, so a key and the flag that sets it cannot drift.
    const ini = render()
    expect(ini).toContain(
      `${ApiNodeIniRenderer.HttpThreadsOption} = ${ApiNodeConfig.DefaultHttpThreads}`
    )
    expect(ini).toContain(
      `${ApiNodeIniRenderer.AgentNameOption} = ${ApiNodeConfig.DefaultAgentName}`
    )
    expect(ini).toContain(
      `${Constants.CHAIN_STATE_DB_SIZE_MB_OPTION} = ${DefaultChainStateDbSizeMb}`
    )
    expect(ApiNodeIniRenderer.PluginOption).toBe("plugin")
  })

  it("does NOT emit database-map-mode (the ticket baseline governs this file)", () => {
    expect(render()).not.toContain("database-map-mode")
  })

  it("ends with a trailing newline", () => {
    expect(render().endsWith("\n")).toBe(true)
  })
})
