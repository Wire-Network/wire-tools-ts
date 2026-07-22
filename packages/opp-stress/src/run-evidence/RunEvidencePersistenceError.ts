/** Stable classifications for run-evidence publication contract failures. */
export enum RunEvidencePersistenceErrorCode {
  InvalidRunIdentity = "invalid_run_identity",
  InvalidState = "invalid_state",
  InvalidRecord = "invalid_record",
  UnsupportedJson = "unsupported_json",
  UnsafeSource = "unsafe_source",
  SourceChanged = "source_changed",
  InvalidArtifact = "invalid_artifact",
  ArtifactConflict = "artifact_conflict"
}

/** Typed non-filesystem failure raised by run-evidence persistence. */
export class RunEvidencePersistenceError extends Error {
  readonly name = "RunEvidencePersistenceError"

  /**
   * @param code Stable failure classification.
   * @param message Human-readable diagnostic.
   * @param options Optional original failure.
   */
  constructor(
    readonly code: RunEvidencePersistenceErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
