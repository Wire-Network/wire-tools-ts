import * as Fs from "node:fs"

import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  OppEnvelopeTelemetryHealthKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidencePersistence,
  RunEvidencePhaseStatus,
  type OppStressRampConfig,
  type OppStressRampIterationObservation,
  type RunEvidenceDecimal,
  type RunEvidencePhase
} from "@wireio/test-opp-stress"

import { writeMetricEnvelopeFixture } from "./oppEnvelopeMetricTestSupport.js"
import {
  allocationDependencies,
  allocationOptions,
  createPersistenceWorkspace,
  successfulSetup,
  type PersistenceWorkspace
} from "./run-evidence/runEvidencePersistenceTestSupport.js"

/** Active real-persistence state used by one schema-v1 ramp test. */
export type SchemaRampHarness = {
  readonly workspace: PersistenceWorkspace
  readonly persistence: RunEvidencePersistence
  readonly cleanup: () => void
}

/** Controls one artifact-backed callback observation. */
export type SchemaObservationOptions = {
  readonly persistence: RunEvidencePersistence
  readonly workspace: PersistenceWorkspace
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly iterationIndex: number
  readonly accountCount: number
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly observationStartedAtMs?: number | bigint
  readonly observationEndedAtMs?: number | bigint
  readonly phaseStartedAtMs?: RunEvidenceDecimal
  readonly phaseEndedAtMs?: RunEvidenceDecimal
  readonly breakage?: {
    readonly category: RampBreakageCategory
    readonly reason: string
  }
}

/** Allocate, capture configuration, and publish successful setup for a ramp. */
export async function createSchemaRampHarness(
  config: OppStressRampConfig,
  requiredEndpoints: readonly RunEvidenceEndpoint[],
  startedAtMs: RunEvidenceDecimal = "100"
): Promise<SchemaRampHarness> {
  const workspace = createPersistenceWorkspace(),
    persistence = await RunEvidencePersistence.allocate(
      {
        ...allocationOptions(workspace),
        rampConfig: config,
        requiredEndpoints,
        startedAtMs
      },
      allocationDependencies()
    )
  await persistence.captureClusterConfig()
  await persistence.publishSetup(successfulSetup())
  return { workspace, persistence, cleanup: workspace.cleanup }
}

/** Build a rich callback observation from generated and captured OPP pairs. */
export async function schemaObservation(
  options: SchemaObservationOptions
): Promise<OppStressRampIterationObservation> {
  const phaseStartedAtMs = options.phaseStartedAtMs ?? "103",
    phaseEndedAtMs = options.phaseEndedAtMs ?? "104",
    phases = await options.requiredEndpoints.reduce<
      Promise<readonly RunEvidencePhase[]>
    >(async (pending, endpoint, endpointIndex) => {
      const collected = await pending,
        baseline = { ...createEnvelopeBaseline([]), artifactRefs: [] },
        epoch = options.iterationIndex * 10 + endpointIndex + 1,
        saturated = options.saturatedEndpoints.includes(endpoint),
        fixtures = [
          writeMetricEnvelopeFixture(
            options.workspace.oppRoot,
            saturated ? 1 : 0,
            { endpointsType: endpointType(endpoint), keyEpoch: epoch }
          ),
          ...(saturated
            ? [
                writeMetricEnvelopeFixture(options.workspace.oppRoot, 0, {
                  endpointsType: endpointType(endpoint),
                  keyEpoch: epoch,
                  payloadSize: 1
                })
              ]
            : [])
        ],
        metrics = await collectOppPhaseMetrics(options.workspace.clusterPath, {
          phase: `iteration-${options.iterationIndex}-endpoint-${endpointIndex}`,
          startedAtMs: phaseStartedAtMs,
          endedAtMs: phaseEndedAtMs,
          epochStart: epoch,
          epochEnd: epoch,
          endpointsType: endpointType(endpoint),
          baseline,
          evidenceSink: options.persistence
        })
      fixtures.forEach(fixture => {
        Fs.rmSync(fixture.dataPath)
        Fs.rmSync(fixture.metadataPath)
      })
      if (
        metrics.evidence.kind !== "recorded" ||
        metrics.health.kind !== OppEnvelopeTelemetryHealthKind.Healthy
      )
        throw new Error("recorded healthy phase expected")
      return [
        ...collected,
        {
          status: RunEvidencePhaseStatus.Completed,
          label: metrics.phase,
          endpoint: metrics.endpoint,
          strategy: metrics.strategy,
          baseline: metrics.evidence.baseline,
          window: metrics.window,
          artifactRefs: metrics.evidence.artifactRefs,
          telemetry: metrics.health,
          metrics: {
            txSuccesses: options.accountCount,
            txFailures: 0,
            envelopeCount: metrics.envelopeCount,
            envelopeByteSizes: metrics.envelopeByteSizes,
            epochEnvelopeIndexes: metrics.epochEnvelopeIndexes,
            solanaOversized: metrics.solanaOversized,
            saturated: metrics.saturated
          }
        }
      ]
    }, Promise.resolve([])),
    first = phases[0]
  if (first === undefined) throw new Error("at least one phase is required")
  const fields = {
    phase: first.label,
    observationStartedAtMs: options.observationStartedAtMs ?? 103,
    observationEndedAtMs: options.observationEndedAtMs ?? 104,
    txSuccesses: first.metrics.txSuccesses,
    txFailures: first.metrics.txFailures,
    envelopeCount: first.metrics.envelopeCount,
    envelopeByteSizes: first.metrics.envelopeByteSizes,
    endpoint: first.endpoint,
    epochStart: Number(first.window.epochStart),
    epochEnd: Number(first.window.epochEnd),
    saturatedEndpoints: options.requiredEndpoints.filter(endpoint =>
      phases.some(
        phase => phase.endpoint === endpoint && phase.metrics.saturated
      )
    ),
    observedNonRequiredEndpoints: [],
    phases,
    endpointTelemetry: options.requiredEndpoints.map(endpoint => {
      const phase = phases.find(value => value.endpoint === endpoint)
      if (phase === undefined) throw new Error("endpoint phase is required")
      return { endpoint, telemetry: phase.telemetry }
    }),
    telemetry: first.telemetry
  }
  return options.breakage === undefined
    ? { kind: "completed", ...fields }
    : {
        kind: "breakage",
        ...fields,
        breakageCategory: options.breakage.category,
        breakageReason: options.breakage.reason
      }
}

function endpointType(
  endpoint: RunEvidenceEndpoint
): DebugOutpostEndpointsType {
  switch (endpoint) {
    case RunEvidenceEndpoint.OutpostEthereumDepot:
      return DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
    case RunEvidenceEndpoint.OutpostSolanaDepot:
      return DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT
    case RunEvidenceEndpoint.DepotOutpostEthereum:
      return DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    case RunEvidenceEndpoint.DepotOutpostSolana:
      return DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    default:
      return assertNever(endpoint)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected test endpoint: ${String(value)}`)
}
