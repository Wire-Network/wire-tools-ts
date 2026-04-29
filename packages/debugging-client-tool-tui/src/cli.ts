import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { asOption } from "@3fv/prelude-ts"
import Yargs from "yargs"
import { hideBin } from "yargs/helpers"
import {
  ClusterFiles,
  type ClusterConfig,
  type ClusterState
} from "@wireio/debugging-shared"
import { type Level } from "@wireio/shared"

/** Result of loading a cluster directory's on-disk files. */
export interface ToolClusterConfig {
  /** Absolute cluster directory (same as `CLI.Args.clusterPath`). */
  path: string
  /** Contents of `cluster-config.json` — always present after create. */
  config: ClusterConfig
  /**
   * Contents of `cluster-state.json` — null before the cluster has been
   * bootstrapped or if the state file is missing. In that case the TUI can
   * still load config-only info (ports, paths) but has no node process state
   * to monitor.
   */
  state: ClusterState | null
}

export namespace CLI {
  export namespace Options {
    /** Yargs option name for the cluster path. */
    export const ClusterPathOption = "cluster-path" as const
    /** Short alias for the cluster path option. */
    export const ClusterPathAlias = "c" as const
    /** Yargs option name for the feature-id filter. */
    export const FeaturesOption = "features" as const
    /** Yargs option name for the root log level. */
    export const LogLevelOption = "log-level" as const
  }

  /** Parsed CLI arguments — resolved and validated. */
  export interface Args {
    /** Absolute path to a cluster directory. */
    clusterPath: string
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
 * Parse argv into a strongly-typed `CLI.Args`. Defaults `--cluster-path` to
 * `process.cwd()` so the TUI is launchable from inside a cluster directory
 * without extra flags.
 */
export function parseArgs(
  argv: readonly string[] = hideBin(process.argv)
): CLI.Args {
  // noinspection JSUnusedGlobalSymbols
  const parsed = Yargs(argv.slice())
    .scriptName("wire-debugging-client-tool-tui")
    .usage(
      "$0 [--cluster-path|-c <path>] [--features <ids>] [--log-level <level>]"
    )
    .option(CLI.Options.ClusterPathOption, {
      alias: CLI.Options.ClusterPathAlias,
      type: "string",
      default: process.cwd(),
      describe:
        "Path to a cluster directory. Defaults to the current directory.",
      coerce: (clusterPath: string) =>
        asOption(Path.resolve(clusterPath))
          .filter(p => Fs.existsSync(Path.join(p, ClusterFiles.ConfigFilename)))
          .getOrThrow(
            `${ClusterFiles.ConfigFilename} not found in ${clusterPath} — is this a cluster directory?`
          )
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
    .strict()
    .help()
    .parseSync()

  return {
    clusterPath: parsed.clusterPath as string,
    activeFeatureIds: (parsed.features as Set<string> | null) ?? null,
    logLevel: parsed.logLevel as Level
  }
}

/**
 * Load the on-disk cluster shape from a directory produced by
 * `wire-test-cluster create`. Throws if the config file is absent; state is
 * returned as `null` when its file hasn't been written yet.
 */
export function loadCluster(clusterPath: string): ToolClusterConfig {
  Assert.ok(
    Fs.existsSync(clusterPath),
    `Cluster path does not exist: ${clusterPath}`
  )
  const configFile = Path.join(clusterPath, ClusterFiles.ConfigFilename),
    stateFile = Path.join(clusterPath, ClusterFiles.StateFilename)
  Assert.ok(
    Fs.existsSync(configFile),
    `${ClusterFiles.ConfigFilename} not found in ${clusterPath} — is this a cluster directory?`
  )
  const config = JSON.parse(
      Fs.readFileSync(configFile, "utf-8")
    ) as ClusterConfig,
    state = asOption(Fs.existsSync(stateFile))
      .filter(Boolean)
      .map(
        () => JSON.parse(Fs.readFileSync(stateFile, "utf-8")) as ClusterState
      )
      .getOrNull()
  return { path: clusterPath, config, state }
}
