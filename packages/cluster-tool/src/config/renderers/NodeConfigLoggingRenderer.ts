import Path from "node:path"
import { Level } from "@wireio/shared"
import { match } from "ts-pattern"
import type { Renderer } from "../../utils/Renderer.js"
import type { NodeConfig } from "../NodeConfig.js"

/**
 * Renders a nodeop `logging.json` (ports the former
 * `cluster/generateLoggingConfig.ts`): a colored stderr sink plus a daily jsonl
 * file sink under the node's `logs/` directory.
 *
 * The logger level comes from the cluster's `logging.levels.console` — it is
 * NOT hardcoded, and the sink it governs is why. libfc filters at the LOGGER,
 * never at the sink: `FC_REFLECT(fc::sink::console_sink_config,
 * (color)(level_colors)(output_type))` declares no `level` field, so one level
 * necessarily drives BOTH sinks and the console — the stream the harness
 * captures — is the binding constraint.
 *
 * This was hardcoded to `debug` for every logger, `net_plugin_impl` included.
 * On a 43-identity cluster that is every block send, receive, vote and nack
 * from every node, and it killed two dispatches on 2026-08-04: run 3 exhausted
 * the runner's socket buffers (`write ENOBUFS`), and run 6 — on far larger
 * hardware — OOM'd the harness at a 4 GB V8 heap in `StreamBase::Writev`
 * after 162 s, because the capture buffer grows faster than it drains. The
 * same volume had already written 88 GB to disk earlier that day and starved
 * finalizer vote propagation. Capping the harness's OWN file appender
 * (`--logging-levels-file`) does not touch this file and cannot fix it.
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
                {
                  level: NodeConfigLoggingRenderer.NodeopLogLevel.debug,
                  color: "green"
                },
                {
                  level: NodeConfigLoggingRenderer.NodeopLogLevel.info,
                  color: "reset"
                },
                {
                  level: NodeConfigLoggingRenderer.NodeopLogLevel.warn,
                  color: "yellow"
                },
                {
                  level: NodeConfigLoggingRenderer.NodeopLogLevel.error,
                  color: "red"
                }
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
          level: NodeConfigLoggingRenderer.toNodeopLevel(this.node.cluster.logging.levels.console),
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
  /**
   * The `fc::log_level` spellings nodeop's `logging.json` accepts, verbatim
   * from `libfc/include/fc/log/log_message.hpp`'s `log_level::values`. An
   * unrecognized spelling is NOT ignored — `fc::from_variant(log_level&)`
   * throws, and the node fails to start.
   */
  export enum NodeopLogLevel {
    all = "all",
    debug = "debug",
    info = "info",
    warn = "warn",
    error = "error",
    off = "off"
  }

  /**
   * Bridge the harness `Level` onto nodeop's `fc::log_level`.
   *
   * The two enums are NOT interchangeable and must never be passed through
   * raw: `Level` carries `trace` and `fatal`, neither of which fc declares,
   * so a raw hand-off emits an invalid level and the node dies on startup.
   * The two ends that do differ map by MEANING — `trace` → fc's `all` (its
   * most verbose), `fatal` → `error` (its most severe *emitting* level;
   * `off` would silence the logger entirely, which is not what fatal means).
   *
   * @param level - The cluster's configured harness log level.
   * @returns The equivalent `fc::log_level` spelling.
   */
  export function toNodeopLevel(level: Level): NodeopLogLevel {
    return match(level)
      .with(Level.trace, () => NodeopLogLevel.all)
      .with(Level.debug, () => NodeopLogLevel.debug)
      .with(Level.info, () => NodeopLogLevel.info)
      .with(Level.warn, () => NodeopLogLevel.warn)
      .with(Level.error, () => NodeopLogLevel.error)
      .with(Level.fatal, () => NodeopLogLevel.error)
      .exhaustive()
  }

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
