import { Constants } from "../../Constants.js"
import { WireClient } from "../../clients/wire/WireClient.js"
import type { Renderer } from "../../utils/Renderer.js"
import { Localhost } from "../../utils/netUtils.js"
import { NodeRole, type NodeConfig } from "../NodeConfig.js"

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
      isOperator = node.role === NodeRole.operator,
      plugins = [
        ...Constants.BASE_PLUGINS,
        ...(isProducer || isBios ? Constants.PRODUCER_PLUGINS : [])
      ],
      kv = (key: string, value: string | number | boolean) =>
        `${key} = ${String(value)}`,
      extraArgs = Constants.NODEOP_EXTRA_ARGS,
      lines = [
        ...plugins.map(plugin => kv("plugin", plugin)),
        "",
        kv("p2p-listen-endpoint", `${listen}:${node.ports.p2p}`),
        kv(
          "p2p-server-address",
          `${NodeConfigIniRenderer.Loopback}:${node.ports.p2p}`
        ),
        kv("http-server-address", `${listen}:${node.ports.http}`),
        ...node.peerEndpoints.map(ep => kv("p2p-peer-address", ep)),
        "",
        kv("blocks-dir", "blocks"),
        ...(isBios ? [kv("enable-stale-production", "true")] : []),
        ...node.producers.map(producer => kv("producer-name", producer)),
        ...(isBios
          ? [kv("signature-provider", Constants.devSignatureProvider())]
          : []),
        ...(isApi || isOperator
          ? [kv("transaction-retry-max-storage-size-gb", 100)]
          : []),
        kv("contracts-console", "true"),
        kv("vote-threads", extraArgs.voteThreads),
        kv("max-transaction-time", extraArgs.maxTransactionTime),
        kv("abi-serializer-max-time-ms", extraArgs.abiSerializerMaxTimeMs),
        kv("max-clients", extraArgs.maxClients),
        kv("connection-cleanup-period", extraArgs.connectionCleanupPeriod),
        kv("http-max-response-time-ms", extraArgs.httpMaxResponseTimeMs),
        ...(isOperator
          ? [kv("read-mode", WireClient.FinalityType.irreversible)]
          : []),
        ...(isOperator && node.batchOperatorAccount
          ? [kv("batch-operator-account", node.batchOperatorAccount)]
          : []),
        ...(isOperator && node.underwriterAccount
          ? [kv("underwriter-account", node.underwriterAccount)]
          : []),
        ...NodeConfigIniRenderer.HttpInsecureLines,
        ""
      ]
    return lines.join("\n")
  }
}

export namespace NodeConfigIniRenderer {
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
    "http-validate-host = false"
  ]
}
