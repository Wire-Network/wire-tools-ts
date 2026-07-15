import { getLogger } from "@wireio/cluster-tool/logging"
import { ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import { fixtureConfig, PersistedFixture } from "./clusterConfigFixture.js"

const log = getLogger(__filename)

/**
 * A REAL {@link ClusterBuildContext} over the persisted fixture config — the
 * typed stand-in for runner tests. Clients are lazy getters, so constructing
 * one needs no binaries or network; `outputs` / `keyStore` are the live
 * stores. Never fake a context with a cast — runners read `ctx.config` paths,
 * so point the fixture at the test's temp dirs via `overrides`.
 *
 * @param overrides - Top-level fixture fields to replace (see
 *   {@link fixtureConfig}); typically `clusterPath` / `dataPath` /
 *   `ethereumPath` / `solanaPath` aimed at a `mkdtemp` sandbox.
 */
export function fixtureContext(
  overrides: Partial<typeof PersistedFixture> = {}
): ClusterBuildContext {
  return new ClusterBuildContext(fixtureConfig(overrides), log)
}
