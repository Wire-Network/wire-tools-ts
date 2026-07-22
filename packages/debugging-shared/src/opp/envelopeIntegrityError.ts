import { inspect } from "node:util"

import type {
  EnvelopeIntegrityFileError,
  EnvelopeIntegrityFileOperation
} from "./EnvelopeIntegrityReaderTypes.js"

/**
 * Normalize an unknown failure into JSON-safe string fields.
 * @param error Value thrown by an untrusted collaborator.
 * @param operation Filesystem stage associated with the failure.
 * @returns Total string-only diagnostic safe for JSON serialization.
 */
export function normalizeUnknownError(
  error: unknown,
  operation: EnvelopeIntegrityFileOperation
): EnvelopeIntegrityFileError {
  const name = readProperty(error, "name"),
    message = readProperty(error, "message"),
    code = readProperty(error, "code")
  return {
    name: name.found ? stringifyUnknown(name.value) : typeof error,
    code: code.found ? stringifyUnknown(code.value) : null,
    message: message.found
      ? stringifyUnknown(message.value)
      : stringifyUnknown(error),
    operation
  }
}

/**
 * Extract a total JSON-safe message from an unknown decoder failure.
 * @param error Value thrown by the protobuf decoder.
 * @returns String diagnostic that cannot retain BigInt, object, or symbol values.
 */
export function unknownErrorMessage(error: unknown): string {
  const message = readProperty(error, "message")
  return message.found
    ? stringifyUnknown(message.value)
    : stringifyUnknown(error)
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return inspect(value, { customInspect: false, getters: false })
  } catch {
    return typeof value
  }
}

function readProperty(
  value: unknown,
  key: "name" | "message" | "code"
):
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false } {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return { found: false }
  }
  try {
    return key in value
      ? { found: true, value: Reflect.get(value, key) }
      : { found: false }
  } catch (error) {
    return { found: true, value: error }
  }
}
