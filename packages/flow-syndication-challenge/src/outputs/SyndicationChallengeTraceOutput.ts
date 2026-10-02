import type { SysioContracts } from "@wireio/sdk-core"
import type { WireClient } from "@wireio/cluster-tool"

/** Nodeop's structured transaction log, used to correlate the probe's console output. */
export interface SyndicationChallengeTraceOutput {
  /** Transaction identity from the existing client response type. */
  readonly id: WireClient.GetTransactionResponse["id"]
  /** A failed execution cannot prove the admitted probe. */
  readonly except?: unknown
  /** Console output belongs to its individual action, not the whole log. */
  readonly action_traces: SyndicationChallengeTraceOutput.Action[]
}

export namespace SyndicationChallengeTraceOutput {
  /** The action fields inspected after selecting sysio.synd::onsynd. */
  export interface Invocation {
    /** Contract receiving the invocation. */
    readonly account: string
    /** ABI action name. */
    readonly name: string
    /** Decoded onsynd ABI data; selected only after checking account/name. */
    readonly data: SysioContracts.SysioSyndOnsyndAction
  }

  /** One action's console record in the enclosing transaction. */
  export interface Action {
    /** Executing receiver, excluding other notifications. */
    readonly receiver: string
    /** Decoded invocation. */
    readonly act: Invocation
    /** Contract console emitted by this action. */
    readonly console: string
  }
}
