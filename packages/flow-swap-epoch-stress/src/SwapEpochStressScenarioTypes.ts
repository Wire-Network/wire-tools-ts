/** Terminal result emitted by the swap epoch stress flow. */
export enum SwapEpochStressOutcome {
  completed = "SWAP_EPOCH_STRESS_COMPLETED",
  failed = "SWAP_EPOCH_STRESS_FAILED"
}

/** Independently evaluated invariant failures reported by the stress flow. */
export enum SwapEpochStressCheck {
  actorProvisioning = "ACTOR_PROVISIONING_FAILED",
  requestSubmission = "REQUEST_SUBMISSION_FAILED",
  uwreqIngestion = "UWREQ_INGESTION_FAILED",
  underwriting = "UNDERWRITING_FAILED",
  destinationSettlement = "DESTINATION_SETTLEMENT_FAILED",
  epochLiveness = "EPOCH_LIVENESS_FAILED",
  chainRuntime = "CHAIN_RUNTIME_FAILED",
  diagnosticCollection = "DIAGNOSTIC_COLLECTION_FAILED"
}

/** High-confidence runtime failure categories collected as supporting evidence. */
export enum SwapEpochStressRuntimeFailureKind {
  solanaMemory = "SOLANA_MEMORY_FAILURE",
  solanaProgram = "SOLANA_PROGRAM_FAILURE",
  processFatal = "PROCESS_FATAL_FAILURE"
}
