import { KeyType } from "@wireio/sdk-core"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { WireClient } from "../../clients/wire/WireClient.js"
import type { WireKeyPair } from "../../types/KeyPair.js"
import { toIniLine } from "../../utils/iniUtils.js"
import type { Renderer } from "../../utils/Renderer.js"
import { Localhost } from "../../utils/netUtils.js"
import { ClusterConfigProvider } from "../ClusterConfigProvider.js"
import { NodeConfig, NodeRole } from "../NodeConfig.js"

/**
 * Renders a nodeop `config.ini` (folds the former `cluster/Config.ts`
 * `generateConfigFileContent` + `cluster/NodeConfig.ts` `nodeConfigToIniOptions`).
 * The listen address comes from `cluster.bind.nodeop.address` (loopback, or
 * `0.0.0.0` under bind-all); the advertised peer address stays loopback (a
 * `0.0.0.0` listen cannot be advertised).
 */
export class NodeConfigIniRenderer implements Renderer {
  constructor(private readonly node: NodeConfig) {}

  render(): string {
    const node = this.node,
      listen = node.cluster.bind.nodeop.address,
      isBios = node.role === NodeRole.bios,
      isProducer = node.role === NodeRole.producer && node.producers.length > 0,
      isApi = node.role === NodeRole.producer && node.producers.length === 0,
      isOperator = NodeConfig.isOperatorRole(node.role),
      plugins = [
        ...Constants.BASE_PLUGINS,
        ...(isProducer || isBios ? Constants.PRODUCER_PLUGINS : []),
        // The conjunction is LOAD-BEARING. `runsTraceApiPlugin` is true for
        // operators, but an operator ini has never carried a trace_api line
        // (operators get BASE_PLUGINS only, and the daemon args add the rest),
        // and an `isApi` node must not gain one either. Net effect: local is
        // unchanged; an EXTERNAL producer / bios loses the line (SHARED-25 AC#4).
        ...((isProducer || isBios) && NodeConfig.runsTraceApiPlugin(node)
          ? [Constants.TRACE_API_PLUGIN]
          : [])
      ],
      extraArgs = Constants.NODEOP_EXTRA_ARGS,
      lines = [
        ...plugins.map(plugin => toIniLine("plugin", plugin)),
        "",
        toIniLine("p2p-listen-endpoint", `${listen}:${node.ports.p2p}`),
        toIniLine(
          "p2p-server-address",
          `${node.advertiseAddress}:${node.ports.p2p}`
        ),
        toIniLine("http-server-address", `${listen}:${node.ports.http}`),
        ...node.peerEndpoints.map(ep => toIniLine("p2p-peer-address", ep)),
        "",
        toIniLine("blocks-dir", "blocks"),
        ...(isBios ? [toIniLine("enable-stale-production", "true")] : []),
        ...node.producers.map(producer => toIniLine("producer-name", producer)),
        ...(isBios
          ? [
              toIniLine(
                "signature-provider",
                NodeConfigIniRenderer.biosSignatureProvider(node)
              )
            ]
          : []),
        ...(isApi || isOperator
          ? [toIniLine("transaction-retry-max-storage-size-gb", 100)]
          : []),
        toIniLine("contracts-console", "true"),
        toIniLine("vote-threads", extraArgs.voteThreads),
        // Topology-derived, NOT a fixed cap: every node is meshed with every
        // other, so a `max-clients` below the mesh size makes each node refuse
        // the surplus inbound dials and LIB freezes at scale. See
        // NodeConfig.peerCapacity.
        toIniLine("max-clients", NodeConfig.peerCapacity(node.cluster)),
        toIniLine(
          "p2p-max-nodes-per-host",
          NodeConfig.peerCapacity(node.cluster)
        ),
        toIniLine(
          "connection-cleanup-period",
          extraArgs.connectionCleanupPeriod
        ),
        // The operator's `batch-operator-account` / `underwriter-account` is
        // NOT rendered here: the chain account is node-owner-generated at
        // provisioning time, so it rides the daemon CLI args
        // (`OperatorDaemonTool`) resolved from the key store at start.
        ...(isOperator
          ? [toIniLine("read-mode", WireClient.FinalityType.irreversible)]
          : []),
        ...NodeConfigIniRenderer.HttpInsecureLines,
        ""
      ]
    return lines.join("\n")
  }
}

export namespace NodeConfigIniRenderer {
  /**
   * The bios node's `signature-provider` value — its genesis K1 authority
   * (`cluster.initialKey`, resolved by
   * `ClusterConfigProvider.resolveWithBiosKeys`), sourced per the cluster's
   * signature provider: inline `KEY:` (the default), `SSM:<secret id>`, or
   * `KIOD:<url>`.
   *
   * Only a `KEY:` spec embeds a private key, and a KEY cluster's bios key is
   * ALWAYS the well-known dev pair (bios key GENERATION happens only under SSM)
   * — so the dev private key below is the correct one exactly when it is used
   * and ignored in every other branch. That makes the KEY rendering
   * byte-identical to the historical `Constants.devSignatureProvider()`.
   *
   * @param node - The bios node (its `cluster` carries the provider config, and
   *   its `name` is the SSM secret-id `{account}` segment — the same one
   *   `NodeopProcess.buildArgs` renders).
   * @returns The `<name>,wire,wire,<pub>,<SCHEME>:<...>` provider spec.
   */
  export function biosSignatureProvider(node: NodeConfig): string {
    const cluster = node.cluster,
      biosKey: WireKeyPair = {
        type: KeyType.K1,
        publicKey: cluster.initialKey,
        privateKey: Constants.DEV_K1_PRIVATE_KEY
      }
    return KeyGenerator.toSignatureProvider(
      biosKey,
      undefined,
      ClusterConfigProvider.signatureProviderSource(cluster)(
        node.name,
        KeyType.K1
      )
    )
  }

  /** Advertised peer / server address (a `0.0.0.0` listen cannot be advertised) —
   *  sourced from `netUtils.Localhost`. */
  export const Loopback = Localhost
  /** The permissive HTTP block (mirrors cluster_manager's `_HTTP_INSECURE_CONFIG`). */
  export const HttpInsecureLines: readonly string[] = [
    "",
    "# -- http-insecure settings (cluster_manager) --",
    "access-control-allow-origin = *",
    "access-control-allow-headers = *",
    "verbose-http-errors = true",
    "http-validate-host = false",
    "",
    "# Dev clusters run on workstations that routinely sit above nodeop's 90%",
    "# resource-monitor disk threshold; ephemeral cluster data is tiny, so warn",
    "# instead of self-terminating one second after boot.",
    "resource-monitor-not-shutdown-on-threshold-exceeded = true"
  ]
}
