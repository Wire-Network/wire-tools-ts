import { FetchProvider } from "@wireio/sdk-core"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"

/**
 * A `@wireio/sdk-core` `FetchProvider` that records every chain RPC the
 * `APIClient` performs — table queries, `get_info`, transaction pushes —
 * into the running step's `Report.StepResult.extra` (via
 * {@link StepExtraRecorder}). `WireClient` builds its `APIClient` over this
 * provider, so the whole SDK read/write surface a step's runner drives is
 * captured with zero changes outside `clients/`.
 *
 * Entries are REQUEST-ONLY (path + params, no response payload): identical
 * repeats — the shape every `pollUntil` loop produces — collapse into one
 * entry with a `count` in the recorder, keeping verify/poll steps readable
 * instead of ballooning `extra` with hundreds of rows.
 */
export class RecordingFetchProvider extends FetchProvider {
  override async call(
    args: RecordingFetchProvider.CallArgs
  ): Promise<Awaited<ReturnType<FetchProvider["call"]>>> {
    StepExtraRecorder.record({
      client: "wire",
      kind: "rpc",
      path: args.path,
      params: RecordingFetchProvider.toWireForm(args.params)
    })
    return super.call(args)
  }
}

export namespace RecordingFetchProvider {
  /**
   * The `FetchProvider.call` argument shape — DERIVED from the SDK's own
   * signature (path + params + method + headers), never re-declared, so an
   * upstream change lands on the override through the compiler.
   */
  export type CallArgs = Parameters<FetchProvider["call"]>[0]

  /**
   * The params exactly as they serialize onto the wire. Antelope value types
   * (`Name`, `UInt64`, …) carry BN internals as object graphs; a JSON
   * round-trip honors each type's `toJSON` (the same encoding `FetchProvider`
   * sends), so the record reads `"sysio.opreg"` — not `{"words": [...]}`.
   */
  export function toWireForm(
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    return params != null
      ? (JSON.parse(JSON.stringify(params)) as Record<string, unknown>)
      : null
  }
}
