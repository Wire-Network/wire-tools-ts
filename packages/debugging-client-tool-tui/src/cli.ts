import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import Yargs from "yargs"
import { hideBin } from "yargs/helpers"

import {
  ClusterFiles,
  type ClusterConfig,
  type ClusterState
} from "@wire-e2e-tests/debugging-shared"

/** Parsed CLI arguments — resolved and validated. */
export interface CLIArgs {
  /** Absolute path to a cluster directory. */
  clusterPath: string
}

/** Result of loading a cluster directory's on-disk files. */
export interface LoadedCluster {
  /** Absolute cluster directory (same as `CLIArgs.clusterPath`). */
  path: string
  /** Contents of `cluster-config.json` — always present after create. */
  config: ClusterConfig
  /**
   * Contents of `cluster-state.json` — null before the cluster has been
   * bootstrapped or if the state file is missing. In that case the TUI
   * can still load config-only info (ports, paths) but has no node
   * process state to monitor.
   */
  state: ClusterState | null
}

export namespace CLI {
  /** Yargs option name for the cluster path. */
  export const ClusterPathOption = "cluster-path" as const
  /** Short alias for the cluster path option. */
  export const ClusterPathAlias = "c" as const
}

/**
 * Parse argv into a strongly-typed `CLIArgs`. Defaults `--cluster-path` to
 * `process.cwd()` so the TUI is launchable from inside a cluster directory
 * without extra flags.
 */
export function parseArgs(
  argv: readonly string[] = hideBin(process.argv)
): CLIArgs {
  const parsed = Yargs(argv.slice())
    .scriptName("wire-debugging-client-tool-tui")
    .usage("$0 [--cluster-path|-c <path>]")
    .option(CLI.ClusterPathOption, {
      alias: CLI.ClusterPathAlias,
      type: "string",
      default: process.cwd(),
      describe:
        "Path to a cluster directory. Defaults to the current directory."
    })
    .strict()
    .help()
    .parseSync()

  return { clusterPath: Path.resolve(parsed.clusterPath as string) }
}

/**
 * Load the on-disk cluster shape from a directory produced by
 * `wire-test-cluster create`. Throws if the config file is absent; state is
 * returned as `null` when its file hasn't been written yet.
 */
export function loadCluster(clusterPath: string): LoadedCluster {
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
    state: ClusterState | null = Fs.existsSync(stateFile)
      ? (JSON.parse(Fs.readFileSync(stateFile, "utf-8")) as ClusterState)
      : null

  return { path: clusterPath, config, state }
}
