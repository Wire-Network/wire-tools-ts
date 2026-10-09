import { NestedError } from "@wireio/shared"

/** Raised when text cannot be formatted (carries the parse diagnostics as context). */
export class QueryFormatError extends NestedError {}
