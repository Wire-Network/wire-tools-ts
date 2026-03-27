/**
 * Generates logging.json for nodeop instances.
 *
 * Mirrors the Python TestHarness/launcher.py `write_logging_config_file()` method.
 */

/**
 * Standard logging.json content matching the Python launcher output.
 * All loggers at "debug" level writing to stderr with color.
 */
export function generateLoggingConfig(): object {
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
            { level: "error", color: "red" },
          ],
        },
      },
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
      "transaction",
    ].map(name => ({
      name,
      level: "debug",
      enabled: true,
      sinks: ["stderr_color"],
    })),
  }
}
