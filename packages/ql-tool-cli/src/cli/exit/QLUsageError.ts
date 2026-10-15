import { NestedError } from "@wireio/shared"

/**
 * A command-line usage problem the user fixes by changing the invocation (no
 * connection, two query sources, an unknown output extension, …) — exits with
 * `QLExitCode.usage`, unlike operational failures (`QLExitCode.failure`).
 */
export class QLUsageError extends NestedError {}
