import {
  RunEvidenceClusterConfigState,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidenceSetupStatus
} from "./runEvidenceConstants.js"
import type {
  RunEvidenceClusterConfigSnapshot,
  RunEvidenceDecimal,
  RunEvidenceIterationRecordRef,
  RunEvidenceSetupRecordRef
} from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type {
  RunEvidenceIteration,
  RunEvidenceSetup,
  RunEvidenceTerminal
} from "./RunEvidenceRecordTypes.js"
import { canonicalEvidenceJson } from "./canonicalEvidenceJson.js"
import {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./RunEvidencePersistenceError.js"
import { parseRunEvidenceIteration } from "./runEvidenceIterationParser.js"
import {
  parseRunEvidenceSetup,
  parseRunEvidenceTerminal
} from "./runEvidenceLifecycleParser.js"

/** Captured config variant required after successful setup. */
export type PersistenceCapturedConfig = Extract<
  RunEvidenceClusterConfigSnapshot,
  { readonly kind: RunEvidenceClusterConfigState.Captured }
>

/** Controller state compared with a candidate terminal record. */
export type TerminalAgreementInput = {
  readonly manifest: RunEvidenceManifest
  readonly setup: RunEvidenceSetup
  readonly iterationRefs: readonly RunEvidenceIterationRecordRef[]
  readonly iterations: readonly RunEvidenceIteration[]
  readonly terminal: RunEvidenceTerminal
}

/** Parse and require a schema-v1 setup record. */
export function requirePersistenceSetup(input: unknown): RunEvidenceSetup {
  const result = parseRunEvidenceSetup(canonicalBoundaryInput(input))
  if ("error" in result) throw invalidRecord("setup", result.error.code)
  return result.value
}

/** Parse and require a schema-v1 iteration record. */
export function requirePersistenceIteration(
  input: unknown
): RunEvidenceIteration {
  const result = parseRunEvidenceIteration(canonicalBoundaryInput(input))
  if ("error" in result) throw invalidRecord("iteration", result.error.code)
  return result.value
}

/** Parse and require a schema-v1 terminal record. */
export function requirePersistenceTerminal(
  input: unknown
): RunEvidenceTerminal {
  const result = parseRunEvidenceTerminal(canonicalBoundaryInput(input))
  if ("error" in result) throw invalidRecord("terminal", result.error.code)
  return result.value
}

function canonicalBoundaryInput(input: unknown): unknown {
  const canonical: unknown = JSON.parse(canonicalEvidenceJson(input).toString())
  return canonical
}

/** Create a typed persistence state failure. */
export function invalidPersistenceState(
  message: string
): RunEvidencePersistenceError {
  return new RunEvidencePersistenceError(
    RunEvidencePersistenceErrorCode.InvalidState,
    message
  )
}

/** Compare ordered controller-owned string sets exactly. */
export function samePersistenceStrings(
  first: readonly string[],
  second: readonly string[]
): boolean {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  )
}

/** Compare ordered immutable iteration refs exactly. */
export function samePersistenceRefs(
  first: readonly RunEvidenceIterationRecordRef[],
  second: readonly RunEvidenceIterationRecordRef[]
): boolean {
  return (
    first.length === second.length &&
    first.every(
      (ref, index) =>
        ref.path === second[index]?.path && ref.sha256 === second[index]?.sha256
    )
  )
}

/** Convert a non-negative observation counter to the schema decimal type. */
export function persistenceDecimal(value: bigint): RunEvidenceDecimal {
  const text = value.toString(10)
  if (!isRunEvidenceDecimal(text))
    throw invalidPersistenceState("observation ordinal is not a decimal")
  return text
}

/** Require an unknown boundary value to be a canonical non-negative decimal. */
export function requirePersistenceDecimal(value: unknown): RunEvidenceDecimal {
  if (typeof value !== "string" || !isRunEvidenceDecimal(value))
    throw invalidPersistenceState("timestamp is not a canonical decimal")
  return value
}

/** Require setup's config claim to match the immutable captured snapshot state. */
export function requirePersistenceConfigAgreement(
  setup: RunEvidenceSetup,
  config: PersistenceCapturedConfig | null
): void {
  if (setup.clusterConfigCreated !== (config !== null))
    throw invalidPersistenceState(
      "setup clusterConfigCreated disagrees with captured config"
    )
}

/** Require the captured config variant needed by successful setup. */
export function requirePersistenceCapturedConfig(
  config: PersistenceCapturedConfig | null
): PersistenceCapturedConfig {
  if (config === null)
    throw invalidPersistenceState("cluster config is not captured")
  return config
}

/** Require a committed setup record from serialized store state. */
export function requireCommittedPersistenceSetup(
  setup: RunEvidenceSetup | null
): RunEvidenceSetup {
  if (setup === null)
    throw invalidPersistenceState("setup.json is not committed")
  return setup
}

/** Require a committed setup ref from serialized store state. */
export function requireCommittedPersistenceSetupRef(
  setupRef: RunEvidenceSetupRecordRef | null
): RunEvidenceSetupRecordRef {
  if (setupRef === null)
    throw invalidPersistenceState("setup ref is not committed")
  return setupRef
}

/** Require a record's endpoint order to equal allocation authority. */
export function requirePersistenceEndpoints(
  endpoints: readonly string[],
  manifest: RunEvidenceManifest
): void {
  if (!samePersistenceStrings(endpoints, manifest.requiredEndpoints))
    throw invalidPersistenceState(
      "record required endpoints disagree with allocation"
    )
}

/** Require terminal start, refs, endpoints, and setup lifecycle agreement. */
export function requirePersistenceTerminalAgreement(
  input: TerminalAgreementInput
): void {
  requirePersistenceEndpoints(input.terminal.requiredEndpoints, input.manifest)
  if (input.terminal.startedAtMs !== input.manifest.startedAtMs)
    throw invalidPersistenceState(
      "terminal start timestamp disagrees with allocation"
    )
  if (!samePersistenceRefs(input.terminal.iterationRefs, input.iterationRefs))
    throw invalidPersistenceState(
      "terminal iteration refs disagree with committed refs"
    )
  const setupFailed = input.setup.status === RunEvidenceSetupStatus.Failed
  if (
    setupFailed !==
    (input.terminal.lifecycle === RunEvidenceLifecycle.SetupFailed)
  )
    throw invalidPersistenceState(
      "terminal lifecycle disagrees with setup outcome"
    )
  if (!setupFailed) requireTerminalIterationAgreement(input)
}

function requireTerminalIterationAgreement(
  input: TerminalAgreementInput
): void {
  const lastIteration = input.iterations.at(-1)
  if (lastIteration === undefined)
    throw invalidPersistenceState("terminal lifecycle requires an iteration")
  const expectedOutcome =
    input.terminal.lifecycle === RunEvidenceLifecycle.Saturated
      ? RunEvidenceIterationOutcome.Saturated
      : input.terminal.lifecycle === RunEvidenceLifecycle.Incomplete
        ? RunEvidenceIterationOutcome.NotSaturated
        : RunEvidenceIterationOutcome.Breakage
  if (lastIteration.outcome !== expectedOutcome)
    throw invalidPersistenceState(
      "terminal lifecycle disagrees with last iteration"
    )
  if (
    !samePersistenceStrings(
      input.terminal.saturatedEndpoints,
      lastIteration.saturatedEndpoints
    ) ||
    !samePersistenceStrings(
      input.terminal.missingEndpoints,
      lastIteration.missingEndpoints
    ) ||
    !samePersistenceJson(
      input.terminal.endpointResults,
      lastIteration.endpointResults
    ) ||
    !samePersistenceJson(input.terminal.telemetry, lastIteration.telemetry)
  )
    throw invalidPersistenceState(
      "terminal endpoint decision disagrees with last iteration"
    )
}

function samePersistenceJson(first: unknown, second: unknown): boolean {
  return canonicalEvidenceJson(first).equals(canonicalEvidenceJson(second))
}

function invalidRecord(
  record: string,
  code: string
): RunEvidencePersistenceError {
  return new RunEvidencePersistenceError(
    RunEvidencePersistenceErrorCode.InvalidRecord,
    `${record} record is not schema-v1 valid: ${code}`
  )
}

function isRunEvidenceDecimal(value: string): value is RunEvidenceDecimal {
  return /^(0|[1-9]\d*)$/.test(value)
}
