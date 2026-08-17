/**
 * Telemetry-side names for the strict envelope-reader issue taxonomy.
 *
 * These are ALIASES, not a parallel taxonomy. The strict reader in
 * `../envelope-integrity/` owns the 25 codes and their per-code context
 * shapes; telemetry consumes them unchanged. Re-declaring them here produced
 * an exact clone — same 25 members, same string values, same order, and 11
 * context interfaces that differed from the originals only in name — plus a
 * 188-line "mapper" whose every arm was the identity function. The alias keeps
 * the established telemetry spelling with ONE declaration and no drift.
 */
export {
  EnvelopeIntegrityIssueCode as OppEnvelopeTelemetryIssueCode
} from "../envelope-integrity/index.js"

export type {
  /** Exact strict-reader filesystem operation retained in telemetry. */
  EnvelopeIntegrityFileOperation as OppEnvelopeTelemetryFileOperation,
  /** Exact JSON-safe strict-reader filesystem error retained in telemetry. */
  EnvelopeIntegrityFileError as OppEnvelopeTelemetryFileError,
  /** Exact JSON-safe strict-reader file identity retained in telemetry. */
  EnvelopeIntegrityFileIdentity as OppEnvelopeTelemetryFileIdentity,
  /** JSON-safe integrity issue keyed by its candidate base key or `$storage`. */
  EnvelopeIntegrityIssue as OppEnvelopeTelemetryIssue
} from "../envelope-integrity/index.js"
