import { Constants } from "../../Constants.js"
import { toIniLine } from "../../utils/iniUtils.js"
import type { Renderer } from "../../utils/Renderer.js"
import type { ApiNodeConfig } from "../ApiNodeConfig.js"

/**
 * Renders a STANDALONE API node's nodeop `config.ini` — the `create-api-node`
 * artifact. Unlike {@link NodeConfigIniRenderer} it derives from no
 * `ClusterConfig`: every value is either supplied on the command line or
 * defaulted by {@link ApiNodeConfig.resolve}.
 *
 * Every ini KEY it emits is a named constant in the companion namespace below,
 * and `CreateApiNodeCommand` registers its `--flags` from those same constants —
 * so a flag name and the ini key it produces cannot drift apart.
 *
 * **Why `net_plugin` is in the emitted plugin set even though the ticket's
 * baseline omits it** — two independent reasons, either sufficient:
 *
 * 1. `p2p-peer-address` is a **net_plugin** option, and `chain_api_plugin`'s
 *    dependency set is only `(chain_plugin)(http_plugin)`. appbase registers the
 *    options of every compiled-in plugin regardless of which are loaded, so
 *    without `net_plugin` the peer lines are accepted-and-IGNORED: nodeop starts
 *    clean, reports no error, and the node never syncs. A silent no-op is the
 *    worst possible failure mode for the one setting that makes an API node
 *    useful.
 * 2. The ticket's own baseline sets `agent-name`, which is likewise
 *    **registered by net_plugin**. The baseline is therefore internally
 *    incomplete as written — it configures a plugin it does not load.
 *
 * **Transitive consequence, and why it is harmless.** Loading `net_plugin`
 * transitively enables `producer_plugin` + `signature_provider_manager_plugin`.
 * Neither produces anything here: no `--producer-name` is configured and
 * stale-production is off, so the node never signs a block — exactly how the
 * harness's own operator nodes run. It does NOT make this a "producer node" for
 * SHARED-25 AC#4 purposes either: an API node is that AC's sanctioned
 * non-public-API exception, which is why it carries `trace_api_plugin` and the
 * elevated finality-status storage straight from the ticket baseline.
 *
 * **`database-map-mode` is deliberately NOT emitted.** The ticket baseline
 * governs this file, and SHARED-28's `mapped_private` default is scoped to the
 * cluster commands' nodeop argv.
 */
export class ApiNodeIniRenderer implements Renderer {
  constructor(private readonly config: ApiNodeConfig) {}

  render(): string {
    const { config } = this,
      { tuning } = config,
      lines = [
        toIniLine(
          Constants.CHAIN_STATE_DB_SIZE_MB_OPTION,
          config.chainStateDbSizeMb
        ),
        toIniLine(
          ApiNodeIniRenderer.TransactionFinalityStatusMaxStorageSizeGbOption,
          tuning.transactionFinalityStatusMaxStorageSizeGb
        ),
        toIniLine(
          ApiNodeIniRenderer.EnableAccountQueriesOption,
          tuning.enableAccountQueries
        ),
        toIniLine(
          ApiNodeIniRenderer.HttpMaxInFlightRequestsOption,
          tuning.httpMaxInFlightRequests
        ),
        toIniLine(ApiNodeIniRenderer.HttpThreadsOption, tuning.httpThreads),
        toIniLine(ApiNodeIniRenderer.AgentNameOption, tuning.agentName),
        toIniLine(
          ApiNodeIniRenderer.HttpServerAddressOption,
          config.httpServerAddress
        ),
        ...config.p2pPeerAddresses.map(peer =>
          toIniLine(ApiNodeIniRenderer.P2pPeerAddressOption, peer)
        ),
        "",
        ...ApiNodeIniRenderer.Plugins.map(plugin =>
          toIniLine(ApiNodeIniRenderer.PluginOption, plugin)
        ),
        ""
      ]
    return lines.join("\n")
  }
}

export namespace ApiNodeIniRenderer {
  /**
   * The plugins a standalone API node loads.
   *
   * Composed from the INDIVIDUAL plugin constants rather than spreading
   * `Constants.BASE_PLUGINS` (`reuse-shared-symbols-never-redeclare.md` — the
   * strings themselves are never re-spelled): the cluster's base set and this
   * artifact's set happen to coincide today, but they answer different
   * questions, and a future cluster-wide base plugin must not silently land in a
   * standalone API node's config.ini. `Constants.TRACE_API_PLUGIN` is the ONE
   * spelling of the trace plugin, shared with the cluster ini renderer and the
   * nodeop argv builder.
   *
   * See the class JSDoc for why `net_plugin` is present despite the ticket's
   * baseline omitting it.
   */
  export const Plugins: readonly string[] = [
    Constants.NET_PLUGIN,
    Constants.CHAIN_API_PLUGIN,
    Constants.TRACE_API_PLUGIN
  ] as const

  /** The repeated `plugin` ini key — one line per {@link Plugins} entry. */
  export const PluginOption = "plugin"

  /**
   * The nodeop option names this file emits, each also the `create-api-node`
   * flag that sets it. They are bare option names (no leading `--`), which is
   * both the ini key and the yargs flag spelling.
   */
  export const TransactionFinalityStatusMaxStorageSizeGbOption =
    "transaction-finality-status-max-storage-size-gb"
  /** `enable-account-queries` — the `/v1/chain/get_accounts_by_authorizers` index. */
  export const EnableAccountQueriesOption = "enable-account-queries"
  /** `http-max-in-flight-requests` — concurrent in-flight HTTP request cap. */
  export const HttpMaxInFlightRequestsOption = "http-max-in-flight-requests"
  /** `http-threads` — size of the HTTP plugin's thread pool. */
  export const HttpThreadsOption = "http-threads"
  /** `agent-name` — the node's advertised p2p handshake name (a net_plugin option). */
  export const AgentNameOption = "agent-name"
  /** `http-server-address` — the deployment endpoint this node serves on. */
  export const HttpServerAddressOption = "http-server-address"
  /** `p2p-peer-address` — repeatable; one line per configured peer. */
  export const P2pPeerAddressOption = "p2p-peer-address"
}
