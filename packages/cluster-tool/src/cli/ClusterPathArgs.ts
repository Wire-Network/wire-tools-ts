import type { Argv } from "yargs"

/** The parsed-argv shape {@link applyClusterPathArgs} produces — the `run` /
 *  `destroy` command handlers' argument type. */
export interface ClusterPathArgv {
  clusterPath: string
}

/**
 * Add the shared `--cluster-path`/`-d` flag to a yargs builder — the ONE
 * `--cluster-path` registration for every command that targets an ALREADY
 * EXISTING cluster directory (`run`, `destroy`). Distinct from `create`'s
 * `cluster-path` leaf (registered by `applyClusterBuildOptionsArgs`), which
 * means "directory to create" and is env-seeded / optional once seeded — this
 * one is always required, no seeding, no defaults.
 *
 * Deliberately generic + un-annotated on return (rather than erasing to a bare
 * `Argv`, as `applyClusterBuildOptionsArgs` does): callers of THIS helper read
 * `args.clusterPath` directly off the parsed argv, so the added leaf's literal
 * type must flow through `Argv`'s generic all the way to the command handler.
 *
 * @param builder - The yargs builder to extend.
 * @returns The extended builder, typed with the added `cluster-path` leaf.
 */
export function applyClusterPathArgs<T>(builder: Argv<T>) {
  return builder.option("cluster-path", {
    alias: "d",
    type: "string",
    demandOption: true,
    describe: "cluster data directory"
  })
}
