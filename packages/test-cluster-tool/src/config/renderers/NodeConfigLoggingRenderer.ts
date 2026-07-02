import Path from "node:path"
import type { Renderer } from "../../utils/Renderer.js"
import type { NodeConfig } from "../NodeConfig.js"

/**
 * Renders a nodeop `logging.json` (ports the former
 * `cluster/generateLoggingConfig.ts`): a colored stderr sink plus a daily jsonl
 * file sink under the node's `logs/` directory, with every logger at `debug`.
 */
export class NodeConfigLoggingRenderer implements Renderer {
  constructor(private readonly node: NodeConfig) {}

  render(): string {
    const baseFilename = Path.join(this.node.nodePath, "logs", "logs.jsonl")
    return JSON.stringify(
      {
        includes: [],
        sinks: [
          {
            name: "stderr_color",
            type: "console_sink",
            args: {
              output_type: "stderr",
              color: true,
              level_colors: [
                { level: "debug", color: "green" },
                { level: "info", color: "reset" },
                { level: "warn", color: "yellow" },
                { level: "error", color: "red" }
              ]
            }
          },
          {
            name: "json_daily_file",
            type: "daily_file_sink",
            args: {
              base_filename: baseFilename,
              rotation_hour: 0,
              rotation_minute: 0,
              truncate: false,
              max_files: 5
            },
            format: { type: "json", args: { extra_fields: {} } }
          }
        ],
        loggers: NodeConfigLoggingRenderer.Loggers.map(name => ({
          name,
          level: "debug",
          enabled: true,
          sinks: ["stderr_color", "json_daily_file"]
        }))
      },
      null,
      2
    )
  }
}

export namespace NodeConfigLoggingRenderer {
  /** The loggers wired to both sinks. */
  export const Loggers = [
    "default",
    "net_plugin_impl",
    "http_plugin",
    "producer_plugin",
    "transaction_success_tracing",
    "transaction_failure_tracing",
    "trace_api",
    "transaction_trace_success",
    "transaction_trace_failure",
    "transient_trx_success_tracing",
    "transient_trx_failure_tracing",
    "state_history",
    "vote",
    "transaction"
  ] as const
}
