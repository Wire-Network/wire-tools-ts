import { DebuggingServer } from "@wireio/debugging-server"
import { Report } from "../../../report/Report.js"
import { ClusterBuildContext } from "../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../ClusterBuildStep.js"
import { DebuggingServerKey } from "../../outputs/DebuggingServerOutput.js"

/**
 * Steps for the run's in-process OPP {@link DebuggingServer} — the sink every
 * operator node's `external_debugging_plugin` posts envelopes to (persisted under
 * `<clusterPath>/data/opp-debugging/`, the heartbeat's canonical liveness probe).
 */
export namespace DebuggingServerSteps {
  /**
   * Start the in-process debugging server on the configured bind port and hold
   * it under {@link DebuggingServerKey}. Idempotent: a second start is a no-op
   * when the server is already held.
   */
  export function start<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runStart)
  }

  /** Named runner — `DebuggingServer.create({port, clusterPath})` + `start()`. */
  export async function runStart<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.outputs.has(DebuggingServerKey)) return
    const server = await DebuggingServer.create({
      port: ctx.config.bind.debuggingServer.port,
      clusterPath: ctx.config.clusterPath
    })
    const address = await server.start()
    ctx.outputs.set(DebuggingServerKey, server)
    ctx.log.info(`[debugging-server] listening on ${address.address}:${address.port}`)
  }
}
