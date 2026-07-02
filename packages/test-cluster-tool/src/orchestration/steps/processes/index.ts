import { AnvilProcessSteps } from "./AnvilProcessSteps.js"
import { DebuggingServerSteps } from "./DebuggingServerSteps.js"
import { KiodProcessSteps } from "./KiodProcessSteps.js"
import { NodeopProcessSteps } from "./NodeopProcessSteps.js"
import { SolanaValidatorProcessSteps } from "./SolanaValidatorProcessSteps.js"

/**
 * Step-layer mirror of the managed cluster processes:
 * `Steps.processes.<process>.start(...)`. Each `start` reads `ctx.processManager`,
 * get-or-creates the `*Process` (its constructor auto-registers), and starts it.
 * `debuggingServer` is the run's in-process OPP debugging sink (held via
 * `ctx.outputs`, not the process manager).
 */
export namespace ProcessSteps {
  export import anvil = AnvilProcessSteps
  export import debuggingServer = DebuggingServerSteps
  export import kiod = KiodProcessSteps
  export import nodeop = NodeopProcessSteps
  export import solanaValidator = SolanaValidatorProcessSteps
}
