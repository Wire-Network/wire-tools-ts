/**
 * Schema version written by persisted run evidence records.
 * Changing this value changes every parser, publisher, and verifier contract.
 */
export const RunEvidenceSchemaVersion = 1

/** Persisted run-evidence paths; changing a member changes the schema-v1 layout. */
export enum RunEvidencePath {
  Manifest = "manifest.json",
  Setup = "setup.json",
  Iterations = "iterations",
  Terminal = "terminal.json",
  ClusterConfigSnapshot = "cluster-config.snapshot.json",
  Artifacts = "artifacts/opp"
}

/** Endpoint labels; changing a member changes accepted phase and decision records. */
export enum RunEvidenceEndpoint {
  OutpostEthereumDepot = "OUTPOST_ETHEREUM_DEPOT",
  OutpostSolanaDepot = "OUTPOST_SOLANA_DEPOT",
  DepotOutpostEthereum = "DEPOT_OUTPOST_ETHEREUM",
  DepotOutpostSolana = "DEPOT_OUTPOST_SOLANA"
}

/**
 * Canonical endpoint set used by runtime guards.
 * Changing this list changes which endpoint labels clean schema v1 accepts.
 */
export const RunEvidenceEndpoints = [
  RunEvidenceEndpoint.OutpostEthereumDepot,
  RunEvidenceEndpoint.OutpostSolanaDepot,
  RunEvidenceEndpoint.DepotOutpostEthereum,
  RunEvidenceEndpoint.DepotOutpostSolana
] as const

/** Lifecycle labels; changing a member changes manifest and terminal state machines. */
export enum RunEvidenceLifecycle {
  Initializing = "initializing",
  SetupFailed = "setup_failed",
  Running = "running",
  Failed = "failed",
  Saturated = "saturated",
  Incomplete = "incomplete"
}

/**
 * Canonical lifecycle set used by runtime guards.
 * Changing this list changes which controller states schema v1 accepts.
 */
export const RunEvidenceLifecycles = [
  RunEvidenceLifecycle.Initializing,
  RunEvidenceLifecycle.SetupFailed,
  RunEvidenceLifecycle.Running,
  RunEvidenceLifecycle.Failed,
  RunEvidenceLifecycle.Saturated,
  RunEvidenceLifecycle.Incomplete
] as const

/** Breakage categories; changing a member changes persisted failure classification. */
export enum RampBreakageCategory {
  Workload = "workload",
  TelemetryIntegrity = "telemetry_integrity",
  InvalidObservation = "invalid_observation",
  Infrastructure = "infrastructure"
}

/**
 * Canonical breakage category set used by runtime guards.
 * Changing this list changes which typed failures schema v1 accepts.
 */
export const RampBreakageCategories = [
  RampBreakageCategory.Workload,
  RampBreakageCategory.TelemetryIntegrity,
  RampBreakageCategory.InvalidObservation,
  RampBreakageCategory.Infrastructure
] as const

/** Record stages; changing a member changes standalone record discrimination. */
export enum RunEvidenceStage {
  Setup = "setup",
  Iteration = "iteration",
  Terminal = "terminal"
}

/** Setup outcomes; changing a member changes setup record discrimination. */
export enum RunEvidenceSetupStatus {
  Succeeded = "succeeded",
  Failed = "failed"
}

/** Phase outcomes; changing a member changes phase record discrimination. */
export enum RunEvidencePhaseStatus {
  Completed = "completed",
  Breakage = "breakage"
}

/** Iteration outcomes; changing a member changes controller decision records. */
export enum RunEvidenceIterationOutcome {
  NotSaturated = "not_saturated",
  Saturated = "saturated",
  Breakage = "breakage"
}

/** Saturation strategies; changing a member changes metric recomputation semantics. */
export enum RunEvidenceSaturationStrategy {
  Rollover = "rollover",
  ByteThreshold = "byte_threshold"
}

/**
 * Canonical saturation strategy set used by runtime guards.
 * Changing this list changes how phase metric targets may be recomputed.
 */
export const RunEvidenceSaturationStrategies = [
  RunEvidenceSaturationStrategy.Rollover,
  RunEvidenceSaturationStrategy.ByteThreshold
] as const

/** Cluster-config states; changing a member changes manifest lifecycle compatibility. */
export enum RunEvidenceClusterConfigState {
  Pending = "pending",
  Captured = "captured",
  Unavailable = "unavailable"
}

/** Pre-setup ref states; changing a member changes initial manifest allocation. */
export enum RunEvidenceSetupRefState {
  Pending = "pending"
}

/** Config unavailability reasons; changing a member changes setup-failure evidence. */
export enum RunEvidenceConfigUnavailableReason {
  ClusterConfigNotCreated = "cluster_config_not_created"
}

/** Parser record labels; changing a member changes typed boundary failure identity. */
export enum RunEvidenceRecordKind {
  Manifest = "manifest",
  Setup = "setup",
  Iteration = "iteration",
  Terminal = "terminal",
  Artifact = "artifact",
  Provenance = "provenance"
}

/**
 * Canonical parser record set used by public parse errors.
 * Changing this list changes which record identities parse failures can report.
 */
export const RunEvidenceRecordKinds = [
  RunEvidenceRecordKind.Manifest,
  RunEvidenceRecordKind.Setup,
  RunEvidenceRecordKind.Iteration,
  RunEvidenceRecordKind.Terminal,
  RunEvidenceRecordKind.Artifact,
  RunEvidenceRecordKind.Provenance
] as const

/** Parse result labels; changing a member changes public boundary result handling. */
export enum RunEvidenceParseResultKind {
  Failure = "run_evidence_parse_failure"
}

/** Parse failure codes; changing a member changes public error classification. */
export enum RunEvidenceParseErrorCode {
  UnsupportedSchemaVersion = "unsupported_schema_version",
  InvalidShape = "invalid_shape"
}
