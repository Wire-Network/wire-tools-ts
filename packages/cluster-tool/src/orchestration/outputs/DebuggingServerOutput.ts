import type { DebuggingServer } from "@wireio/debugging-server"
import { outputKey, type OutputKey } from "../OutputStore.js"

/**
 * Typed cross-step handle to the run's in-process {@link DebuggingServer} — the
 * OPP debugging sink every operator node's `external_debugging_plugin` posts to
 * (persisting `<clusterPath>/data/opp-debugging/` artifacts). Started by
 * `Steps.processes.debuggingServer.start`; held here so teardown can stop it.
 */
export const DebuggingServerKey: OutputKey<DebuggingServer> = outputKey(
  "cluster.debuggingServer",
  "the run's in-process OPP debugging server"
)
