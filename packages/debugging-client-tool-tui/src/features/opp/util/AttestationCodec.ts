import {
  AttestationProcessingError,
  AttestationType,
  BatchOperatorGroups,
  ReserveBalanceSheet,
  ChallengeOperatorHash,
  ChallengeRequest,
  DepositRevert,
  NodeOwnerReg,
  OperatorAction,
  Operators,
  PretokenPurchase,
  PretokenYield,
  StakeResult,
  StakeUpdate,
  StakingReward,
  SwapRejected,
  SwapRemit,
  SwapRequest,
  SwapRevert,
  UnderwriteIntentCommit,
  WireTokenPurchase,
  type AttestationEntry
} from "@wireio/opp-typescript-models"

/**
 * Minimal shape of `protobuf-ts` `MessageType` we depend on — just `fromBinary`
 * for decode + `typeName` for the reverse-lookup label. Avoids depending on
 * `@protobuf-ts/runtime` directly.
 */
interface AttestationMessageType {
  readonly typeName: string
  fromBinary(bytes: Uint8Array): unknown
}

/**
 * Single source of truth mapping every `AttestationType` enum value → the
 * `MessageType` that knows how to decode its `data` bytes. Unmapped values
 * (e.g. `UNSPECIFIED`, the few `STAKE`/`UNSTAKE` / pre-launch names for
 * which no companion class is exported by the generated package) fall
 * through to a raw-record render in the panel — no decode is attempted.
 *
 * Keep the keys aligned with `AttestationType`'s identifiers; renames in the
 * generated package surface as compile errors here.
 */
export const AttestationDecoders: Partial<
  Record<AttestationType, AttestationMessageType>
> = {
  [AttestationType.OPERATOR_ACTION]: OperatorAction,
  [AttestationType.PRETOKEN_PURCHASE]: PretokenPurchase,
  [AttestationType.PRETOKEN_YIELD]: PretokenYield,
  [AttestationType.RESERVE_BALANCE_SHEET]: ReserveBalanceSheet,
  [AttestationType.STAKE_UPDATE]: StakeUpdate,
  [AttestationType.WIRE_TOKEN_PURCHASE]: WireTokenPurchase,
  [AttestationType.CHALLENGE_RESPONSE]: ChallengeOperatorHash,
  [AttestationType.SWAP_REQUEST]: SwapRequest,
  [AttestationType.SWAP_REMIT]: SwapRemit,
  [AttestationType.CHALLENGE_REQUEST]: ChallengeRequest,
  [AttestationType.OPERATORS]: Operators,
  [AttestationType.BATCH_OPERATOR_GROUPS]: BatchOperatorGroups,
  [AttestationType.NODE_OWNER_REG]: NodeOwnerReg,
  [AttestationType.STAKING_REWARD]: StakingReward,
  [AttestationType.STAKE_RESULT]: StakeResult,
  [AttestationType.ATTESTATION_PROCESSING_ERROR]: AttestationProcessingError,
  [AttestationType.UNDERWRITE_INTENT_COMMIT]: UnderwriteIntentCommit,
  [AttestationType.SWAP_REVERT]: SwapRevert,
  [AttestationType.DEPOSIT_REVERT]: DepositRevert,
  [AttestationType.SWAP_REJECTED]: SwapRejected
}

/**
 * Result of decoding one attestation entry. `kind` discriminates the two
 * outcomes for the UI — a successful decode renders the typed message
 * pretty-printed; the raw fallback renders the entry as-is so the user
 * still sees something.
 */
export type DecodedAttestation =
  | { kind: "decoded"; typeName: string; value: unknown }
  | { kind: "raw"; reason: string; entry: AttestationEntry }

/**
 * Decode an attestation entry's `data` bytes via the type-matched
 * `MessageType`. Returns a `raw` discriminator on:
 *   - missing decoder for the entry's type
 *   - non-binary `data` shape (after JSON-roundtrip through Redux, `data`
 *     is a base64 string — we transparently re-encode here)
 *   - any thrown error during binary decoding
 *
 * @param entry attestation entry from the Redux-backed `Envelope`
 */
export function decodeAttestation(entry: AttestationEntry): DecodedAttestation {
  const decoder = AttestationDecoders[entry.type as AttestationType]
  if (!decoder) {
    return {
      kind: "raw",
      reason: `no decoder registered for AttestationType=${entry.type}`,
      entry
    }
  }
  const bytes = bytesFor(entry.data)
  if (!bytes) {
    return {
      kind: "raw",
      reason: "unrecognized data encoding",
      entry
    }
  }
  try {
    const value = decoder.fromBinary(bytes)
    return { kind: "decoded", typeName: decoder.typeName, value }
  } catch (err) {
    return {
      kind: "raw",
      reason: `decode failed: ${(err as Error).message ?? String(err)}`,
      entry
    }
  }
}

/**
 * Coerce the entry's `data` to a `Uint8Array`. Three accepted shapes:
 *
 *   - `Uint8Array` / `Buffer` — direct passthrough.
 *   - base64 `string` — what a properly-plainified envelope produces.
 *   - `{ type: "Buffer", data: number[] }` — the legacy form `Buffer.toJSON`
 *     produces. JSON.stringify calls `toJSON` BEFORE any replacer, so older
 *     code paths could leak this object shape into Redux. Accepting it here
 *     means already-cached envelopes still decode after the encoder fix.
 *
 * Unknown shapes return `null` so the caller can degrade to a raw render.
 */
function bytesFor(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (typeof data === "string") {
    try {
      return Buffer.from(data, "base64")
    } catch {
      return null
    }
  }
  if (typeof data === "object" && data !== null) {
    const obj = data as { type?: unknown; data?: unknown }
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      return Uint8Array.from(obj.data as number[])
    }
  }
  return null
}

/**
 * Render any value JSON-safely — turns `BigInt` into decimal strings and
 * `Uint8Array` (incl. `Buffer`) into base64. Recursive walk rather than a
 * `JSON.stringify` replacer because `Buffer.prototype.toJSON()` runs BEFORE
 * the replacer and converts the Buffer into `{ type: "Buffer", data: [...] }`,
 * which then never matches the `instanceof Uint8Array` check. Walking the
 * tree manually intercepts every Uint8Array (including Buffer subclass
 * instances) directly.
 */
export function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        jsonSafe(v)
      ])
    )
  }
  return value
}
