import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityIssue,
  type EnvelopeIntegrityIssueSequence
} from "@wireio/debugging-shared"

/**
 * Build the canonical structured baseline capture issue used by failure tests.
 * @returns A deterministic storage-level baseline capture failure.
 */
export function baselineCaptureIssue(): EnvelopeIntegrityIssue {
  return {
    code: EnvelopeIntegrityIssueCode.BaselineCaptureFailed,
    baseKey: "$storage",
    context: {
      storageDir: "/cluster/data/opp-debugging",
      error: {
        name: "Error",
        code: "EACCES",
        message: "permission denied",
        operation: "readdir"
      }
    }
  }
}

/**
 * Build candidate, initiating capture, and retained close issues in source order.
 * @returns A deterministic non-empty sequence spanning every baseline failure stage.
 */
export function orderedBaselineCaptureIssues(): EnvelopeIntegrityIssueSequence {
  return [
    {
      code: EnvelopeIntegrityIssueCode.StorageRootNotDirectory,
      baseKey: "$storage",
      context: { path: "/cluster/data/opp-debugging" }
    },
    baselineCaptureIssue(),
    {
      code: EnvelopeIntegrityIssueCode.StorageRootReadFailed,
      baseKey: "$storage",
      context: {
        path: "/cluster/data/opp-debugging",
        error: {
          name: "Error",
          code: "EIO",
          message: "close failed",
          operation: "root_close"
        }
      }
    }
  ]
}
