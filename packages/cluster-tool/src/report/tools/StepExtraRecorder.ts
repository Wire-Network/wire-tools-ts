import { AsyncLocalStorage } from "node:async_hooks"
import { plainify } from "@wireio/debugging-shared"

/**
 * Per-step capture of every client call a step's runner performs — wire
 * actions/RPCs (SDK + clio), Ethereum JSON-RPC sends AND reads, and Solana
 * transactions/RPCs — landing in `Report.StepResult.extra` as a plain,
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
 *
 * Read-class calls are recorded REQUEST-ONLY (no result payload), so a poll
 * loop repeating one query collapses into a single entry with a `count` —
 * {@link StepExtraRecorder.DedupeWindow} tolerates interleaved polls (e.g.
 * ethers' receipt/blockNumber alternation). A per-step ceiling
 * ({@link StepExtraRecorder.MaxCalls}) bounds pathological steps; overflow is
 * surfaced as `dropped` on the `extra` object rather than lost silently.
 */
export class StepExtraRecorder {
  private readonly callList: StepExtraRecorder.ClientCall[] = []
  /** Dedupe keys parallel to {@link callList} (never serialized). */
  private readonly keyList: string[] = []
  private droppedCount = 0

  /** The calls recorded so far — internally mutable, externally read-only. */
  get calls(): ReadonlyArray<StepExtraRecorder.ClientCall> {
    return this.callList
  }

  /**
   * Record one client call. The entry is `plainify`d at capture time (bigints,
   * byte arrays, and class instances become JSON-safe plain values) and long
   * strings are capped, so the resulting `extra` object stringifies without
   * modification. A call identical to a recent entry (within
   * {@link StepExtraRecorder.DedupeWindow}) increments that entry's `count`
   * instead of appending — the collapse that keeps poll loops readable.
   *
   * @param call - The call entry (client + kind + call-specific payload data).
   */
  record(call: StepExtraRecorder.ClientCall): void {
    const entry = StepExtraRecorder.capStrings(
      plainify(call)
    ) as StepExtraRecorder.ClientCall
    const key = JSON.stringify(entry)
    const windowStart = Math.max(
      0,
      this.keyList.length - StepExtraRecorder.DedupeWindow
    )
    for (let index = this.keyList.length - 1; index >= windowStart; index--) {
      if (this.keyList[index] === key) {
        const prior = this.callList[index]
        prior.count = ((prior.count as number) ?? 1) + 1
        return
      }
    }
    if (this.callList.length >= StepExtraRecorder.MaxCalls) {
      this.droppedCount++
      return
    }
    this.callList.push(entry)
    this.keyList.push(key)
  }

  /**
   * The step's `Report.StepResult.extra` value: `{ calls: [...] }` (plus
   * `dropped` when the {@link StepExtraRecorder.MaxCalls} ceiling cut
   * entries), or null when the step recorded nothing.
   */
  toExtra(): Record<string, unknown> | null {
    if (this.callList.length === 0) {
      return null
    }
    return this.droppedCount > 0
      ? { calls: [...this.callList], dropped: this.droppedCount }
      : { calls: [...this.callList] }
  }
}

export namespace StepExtraRecorder {
  /**
   * One recorded client call. `client` names the wrapper (`wire`, `clio`,
   * `ethereum`, `solana`); `kind` the call class (`cli`, `rpc`, `call`,
   * `transaction`, …); the rest is call-specific payload data (command lines,
   * action payloads, decoded transactions). `count` appears when consecutive
   * identical calls were collapsed.
   */
  export interface ClientCall {
    client: string
    kind: string
    [key: string]: unknown
  }

  /**
   * How many trailing entries {@link StepExtraRecorder.record} scans for an
   * identical prior call before appending. > 1 so ALTERNATING poll patterns
   * (receipt / blockNumber / receipt / …) still collapse.
   */
  export const DedupeWindow = 5

  /** Per-step recorded-call ceiling; overflow increments `dropped`. */
  export const MaxCalls = 250

  /** Longest string preserved verbatim in a recorded entry. */
  export const MaxStringLength = 600

  /**
   * Deep-cap every string in a plainified value at
   * {@link MaxStringLength}, annotating the elision — raw transaction hex and
   * ABI blobs stay informative without bloating the report.
   */
  export function capStrings(value: unknown): unknown {
    if (typeof value === "string") {
      return value.length > MaxStringLength
        ? `${value.slice(0, MaxStringLength)}…(+${value.length - MaxStringLength} chars)`
        : value
    }
    if (Array.isArray(value)) {
      return value.map(capStrings)
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          capStrings(entry)
        ])
      )
    }
    return value
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

  /**
   * Record a descriptive note onto the current step's recorder — the entry a
   * checkpoint/log-style step (or any runner with context worth keeping)
   * lands in `extra` when there is no client call to capture. `data` merges
   * extra structured fields into the entry.
   */
  export function note(text: string, data: Record<string, unknown> = {}): void {
    current()?.record({ client: "harness", kind: "note", text, ...data })
  }

  /**
   * The `extra` for a step that recorded nothing: a note carrying the step's
   * own description — every step says SOMETHING in `extra`, so a checkpoint
   * step reads as its reason rather than an empty slot.
   */
  export function fallbackExtra(description: string): Record<string, unknown> {
    return { calls: [{ client: "harness", kind: "note", text: description }] }
  }
}
