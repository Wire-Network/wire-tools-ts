import Path from "path"

/**
 * Standard logging.json content matching the Python launcher output.
 * All loggers at "debug" level writing to stderr with color.
 */
export function generateLoggingConfig(nodePath: string): object {
  return {
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
          base_filename: Path.join(nodePath, "logs", "logs.jsonl"),
          rotation_hour: 0,
          rotation_minute: 0,
          truncate: false,
          max_files: 5
        },
        format: {
          type: "json",
          args: {
            extra_fields: {}
          }
        },
        _comment:
          'JSONL output; rotates daily. Attach "json_daily_file" to any logger\'s sinks[] to enable.'
      }
    ],
    loggers: [
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
    ].map(name => ({
      name,
      level: "debug",
      enabled: true,
      sinks: ["stderr_color", "json_daily_file"]
    }))
  }
}
