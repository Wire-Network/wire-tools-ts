import { isNativeError } from "node:util/types"

const MissingRampFailureReason =
  "OPP stress ramp callback failed without a reason"

/**
 * Render an untrusted callback failure without evaluating error accessors.
 * @param cause Arbitrary callback rejection reason.
 * @returns Stable controller-owned failure text.
 */
export function renderRampFailureReason(cause: unknown): string {
  if (isNativeError(cause)) {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
    return descriptor !== undefined &&
      Object.hasOwn(descriptor, "value") &&
      typeof descriptor.value === "string" &&
      descriptor.value.length > 0
      ? descriptor.value
      : MissingRampFailureReason
  }
  if (typeof cause === "string")
    return cause.length > 0 ? cause : MissingRampFailureReason
  if (
    cause === null ||
    cause === undefined ||
    typeof cause === "number" ||
    typeof cause === "bigint" ||
    typeof cause === "boolean" ||
    typeof cause === "symbol"
  )
    return `OPP stress ramp callback rejected with ${String(cause)}`
  return MissingRampFailureReason
}
