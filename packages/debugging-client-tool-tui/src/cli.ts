import Fs from "node:fs"
import Path from "node:path"
import { asOption } from "@3fv/prelude-ts"
import Yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { ClusterFiles } from "@wireio/debugging-shared"
import {
  LocalFileDebuggingClient,
  NetDebuggingClient,
  type DebuggingClient
} from "@wireio/debugging-client-shared"
import { type Level } from "@wireio/shared"

export namespace CLI {
  export namespace Options {
    /** Yargs option name for the local cluster path mode. */
    export const ClusterPathOption = "cluster-path" as const
    /** Short alias for the cluster path option. */
    export const ClusterPathAlias = "c" as const
    /** Yargs option name for the network mode (debugging-server URL). */
    export const ServerUrlOption = "server-url" as const
    /** Short alias for the server URL option. */
    export const ServerUrlAlias = "s" as const
    /** Yargs option name for the feature-id filter. */
    export const FeaturesOption = "features" as const
    /** Yargs option name for the root log level. */
    export const LogLevelOption = "log-level" as const
  }

  /** Mutually-exclusive transport selection captured from the CLI. */
  export type Mode =
    | { kind: "local"; clusterPath: string }
    | { kind: "remote"; serverUrl: string }

  /** Parsed CLI arguments — resolved and validated. */
  export interface Args {
    /** Transport selection — exactly one of local-disk or remote. */
    mode: Mode
    /** Null when `--features` is omitted (all providers active). Lowercased ids otherwise. */
    activeFeatureIds: Set<string> | null
    /** Root log level supplied via `--log-level`, defaults to {@link DefaultLogLevel}. */
    logLevel: Level
  }

  /** Log levels accepted by `--log-level`. */
  export const LogLevels = [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal"
  ] as const
  /** Default `--log-level` when omitted. */
  export const DefaultLogLevel: Level = "info" as Level
}

/** Coerce raw `--features` input to a lowercased id set (or null when omitted). */
export function coerceFeatures(raw?: string): Set<string> | null {
  return asOption(raw)
    .map(s =>
      s
        .split(",")
        .map(x => x.trim().toLowerCase())
        .filter(Boolean)
    )
    .filter(list => list.length > 0)
    .map(list => new Set(list))
    .getOrNull()
}

/**
 * Parse argv into a strongly-typed `CLI.Args`. The TUI requires exactly
 * one of `--cluster-path` (local-disk transport) or `--server-url`
 * (remote debugging-server transport).
 */
export function parseArgs(
  argv: readonly string[] = hideBin(process.argv)
): CLI.Args {
  const parsed = Yargs(argv.slice())
    .scriptName("wire-debugging-client-tool-tui")
    .usage(
      "$0 (--cluster-path|-c <path> | --server-url|-s <url>) [--features <ids>] [--log-level <level>]"
    )
    .option(CLI.Options.ClusterPathOption, {
      alias: CLI.Options.ClusterPathAlias,
      type: "string",
      describe:
        "Path to a cluster directory (local-disk transport). Mutually exclusive with --server-url."
    })
    .option(CLI.Options.ServerUrlOption, {
      alias: CLI.Options.ServerUrlAlias,
      type: "string",
      describe:
        "Base URL of a running debugging-server (remote transport, e.g. http://127.0.0.1:9876). Mutually exclusive with --cluster-path."
    })
    .option(CLI.Options.FeaturesOption, {
      type: "string",
      describe:
        "Comma-separated feature ids to activate (case-insensitive). Required providers are always active.",
      coerce: coerceFeatures
    })
    .option(CLI.Options.LogLevelOption, {
      type: "string",
      default: CLI.DefaultLogLevel,
      choices: CLI.LogLevels,
      describe: "Root log level."
    })
    .check(args => {
      const hasCluster = typeof args.clusterPath === "string",
        hasServer = typeof args.serverUrl === "string"
      if (hasCluster === hasServer) {
        throw new Error(
          `Specify exactly one of --${CLI.Options.ClusterPathOption} or --${CLI.Options.ServerUrlOption}`
        )
      }
      if (hasCluster) {
        const resolved = Path.resolve(args.clusterPath as string),
          configFile = Path.join(resolved, ClusterFiles.ConfigFilename)
        if (!Fs.existsSync(configFile)) {
          throw new Error(
            `${ClusterFiles.ConfigFilename} not found in ${resolved} — is this a cluster directory?`
          )
        }
      }
      return true
    })
    .strict()
    .help()
    .parseSync()

  const mode: CLI.Mode =
    typeof parsed.clusterPath === "string"
      ? { kind: "local", clusterPath: Path.resolve(parsed.clusterPath) }
      : { kind: "remote", serverUrl: parsed.serverUrl as string }

  return {
    mode,
    activeFeatureIds: (parsed.features as Set<string> | null) ?? null,
    logLevel: parsed.logLevel as Level
  }
}

/**
 * Construct the right `DebuggingClient` for the selected mode. Validates
 * connectivity (ping for net mode, file existence for local mode) before
 * returning so launch-time misconfigurations surface immediately.
 */
export async function createClient(mode: CLI.Mode): Promise<DebuggingClient> {
  if (mode.kind === "local") {
    return LocalFileDebuggingClient.create({ clusterPath: mode.clusterPath })
  }
  return NetDebuggingClient.create({ baseUrl: mode.serverUrl })
}
