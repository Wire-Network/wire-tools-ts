import { AsyncLocalStorage } from "node:async_hooks"
import { plainify } from "@wireio/debugging-shared"

/**
 * Per-step capture of every client call a step's runner performs — wire
 * actions/CLI invocations (clio), Ethereum JSON-RPC sends, and Solana
 * transactions — landing in `Report.StepResult.extra` as a plain,
 * JSON-stringify-safe object.
 *
 * The executor (`ClusterBuildPhase.runStep`) creates one recorder per step and
 * runs the step's runner inside {@link StepExtraRecorder.runWith}; the client
 * wrappers (`clients/wire`, `clients/ethereum`, `clients/solana`) call
 * {@link StepExtraRecorder.record} at their call boundaries. AsyncLocalStorage
 * scopes the recorder to the step's async execution, so PARALLEL steps sharing
 * one context/client set each capture only their own calls. Client calls made
 * outside any step (bootstrappers running inside a step still count — they run
 * within the step's async scope) are silently not recorded.
 */
export class StepExtraRecorder {
  private readonly callList: StepExtraRecorder.ClientCall[] = []

  /** The calls recorded so far — internally mutable, externally read-only. */
  get calls(): ReadonlyArray<StepExtraRecorder.ClientCall> {
    return this.callList
  }

  /**
   * Record one client call. The entry is `plainify`d at capture time (bigints,
   * byte arrays, and class instances become JSON-safe plain values) so the
   * resulting `extra` object stringifies without modification.
   *
   * @param call - The call entry (client + kind + call-specific payload data).
   */
  record(call: StepExtraRecorder.ClientCall): void {
    this.callList.push(plainify(call) as StepExtraRecorder.ClientCall)
  }

  /**
   * The step's `Report.StepResult.extra` value: `{ calls: [...] }`, or null
   * when the step recorded nothing.
   */
  toExtra(): Record<string, unknown> | null {
    return this.callList.length > 0 ? { calls: [...this.callList] } : null
  }
}

export namespace StepExtraRecorder {
  /**
   * One recorded client call. `client` names the wrapper (`clio`, `ethereum`,
   * `solana`); `kind` the call class (`cli`, `rpc`, `transaction`, …); the
   * rest is call-specific payload data (command lines, action payloads,
   * decoded transactions).
   */
  export interface ClientCall {
    client: string
    kind: string
    [key: string]: unknown
  }

  const storage = new AsyncLocalStorage<StepExtraRecorder>()

  /** The recorder scoping the CURRENT async execution, or null outside a step. */
  export function current(): StepExtraRecorder | null {
    return storage.getStore() ?? null
  }

  /**
   * Run `body` with `recorder` as the async-scoped current recorder (the
   * executor's per-step wrapper).
   *
   * @param recorder - The step's recorder.
   * @param body - The step execution.
   * @returns `body`'s result.
   */
  export function runWith<T>(
    recorder: StepExtraRecorder,
    body: () => Promise<T>
  ): Promise<T> {
    return storage.run(recorder, body)
  }

  /** Record onto the current step's recorder; a no-op outside any step. */
  export function record(call: ClientCall): void {
    current()?.record(call)
  }
}
