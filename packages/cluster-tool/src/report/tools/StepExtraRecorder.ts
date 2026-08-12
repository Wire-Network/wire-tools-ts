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
 *
 * **Harness NOTES ride a reserved bucket of their own**
 * ({@link StepExtraRecorder.MaxNotes}), never the client-call ceiling. A note
 * is the runner's own semantic account of what it did — the metric it
 * measured, the reason it skipped — and is worth strictly more than any single
 * RPC entry. Sharing one budget let high-volume chatter EVICT them: in a live
 * saturating run every one of the 12 capped steps lost its notes to poll
 * traffic (one payout step dropped 51,186 calls and its note with them),
 * leaving exactly the steps that most needed explaining as the ones that
 * explained nothing.
 */
export class StepExtraRecorder {
  private readonly callList: StepExtraRecorder.ClientCall[] = []
  /** Dedupe keys parallel to {@link callList} (never serialized). */
  private readonly keyList: string[] = []
  private droppedCount = 0
  private readonly noteList: StepExtraRecorder.ClientCall[] = []
  /** Dedupe keys parallel to {@link noteList} (never serialized). */
  private readonly noteKeyList: string[] = []
  private droppedNoteCount = 0

  /** The calls recorded so far — internally mutable, externally read-only. */
  get calls(): ReadonlyArray<StepExtraRecorder.ClientCall> {
    return this.callList
  }

  /** The harness notes recorded so far — internally mutable, externally read-only. */
  get notes(): ReadonlyArray<StepExtraRecorder.ClientCall> {
    return this.noteList
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
    if (
      this.append(call, this.callList, this.keyList, StepExtraRecorder.MaxCalls)
    )
      return
    this.droppedCount++
  }

  /**
   * Record one harness note onto the RESERVED note bucket, so a runner's own
   * account of what it did survives however much client chatter the step also
   * produced.
   *
   * @param call - The note entry (`kind: "note"` plus its merged data).
   */
  recordNote(call: StepExtraRecorder.ClientCall): void {
    if (
      this.append(
        call,
        this.noteList,
        this.noteKeyList,
        StepExtraRecorder.MaxNotes
      )
    )
      return
    this.droppedNoteCount++
  }

  /**
   * Plainify, cap, dedupe-or-append one entry into a bucket.
   *
   * @param call - The raw entry.
   * @param entries - The bucket to append into.
   * @param keys - Dedupe keys parallel to `entries`.
   * @param ceiling - Bucket capacity.
   * @returns `true` when the entry was collapsed or appended; `false` when the
   *   bucket was full and the caller must count it as dropped.
   */
  private append(
    call: StepExtraRecorder.ClientCall,
    entries: StepExtraRecorder.ClientCall[],
    keys: string[],
    ceiling: number
  ): boolean {
    const entry = StepExtraRecorder.capStrings(
        plainify(call)
      ) as StepExtraRecorder.ClientCall,
      key = JSON.stringify(entry),
      windowStart = Math.max(0, keys.length - StepExtraRecorder.DedupeWindow)
    for (let index = keys.length - 1; index >= windowStart; index--) {
      if (keys[index] === key) {
        const prior = entries[index]
        prior.count = ((prior.count as number) ?? 1) + 1
        return true
      }
    }
    if (entries.length >= ceiling) return false
    entries.push(entry)
    keys.push(key)
    return true
  }

  /**
   * The step's `Report.StepResult.extra` value: `{ calls: [...] }` with the
   * step's notes FIRST (they say what the step did; the client calls say how),
   * plus `dropped` / `droppedNotes` when either ceiling cut entries, or null
   * when the step recorded nothing.
   */
  toExtra(): Record<string, unknown> | null {
    if (this.callList.length === 0 && this.noteList.length === 0) {
      return null
    }
    return {
      calls: [...this.noteList, ...this.callList],
      ...(this.droppedCount > 0 ? { dropped: this.droppedCount } : {}),
      ...(this.droppedNoteCount > 0
        ? { droppedNotes: this.droppedNoteCount }
        : {})
    }
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

  /**
   * Per-step harness-NOTE ceiling, budgeted separately from {@link MaxCalls}
   * so client chatter can never evict a runner's own account of the step.
   * Overflow increments `droppedNotes`.
   */
  export const MaxNotes = 100

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
    current()?.recordNote({ client: "harness", kind: "note", text, ...data })
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
