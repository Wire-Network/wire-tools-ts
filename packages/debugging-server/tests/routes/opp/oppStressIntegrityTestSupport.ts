import * as Fs from "node:fs"
import * as Path from "node:path"

import { ApiPaths, captureEnvelopeBaseline } from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope,
  type PutEnvelopeResponse
} from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePersistence,
  RunEvidencePhaseStatus,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupStatus,
  RunEvidenceStage
} from "@wireio/test-opp-stress"

import {
  EnvelopeRouteHarness,
  routePutParams
} from "./envelopeRouteTestSupport.js"

const Epoch = 17,
  StartedAtMs = "100",
  SetupStartedAtMs = "101",
  SetupEndedAtMs = "102",
  PhaseStartedAtMs = "103",
  PhaseEndedAtMs = "104",
  TerminalEndedAtMs = "105"

/** Accepted batch operators expected after concurrent route publication. */
export const Operators = ["batchop.a", "batchop.b"] as const

/** Single endpoint partition exercised throughout the evidence run. */
export const RequiredEndpoint = RunEvidenceEndpoint.OutpostEthereumDepot

/** Complete live HTTP publication and evidence fixture owned by one test. */
export type CompletedRunFixture = Awaited<ReturnType<typeof createCompletedRun>>

/**
 * Publish one rollover envelope through the live route and complete its evidence run.
 * @returns Isolated server, route state, metrics, and persistence handles.
 */
export async function createCompletedRun() {
  const harness = await EnvelopeRouteHarness.start("opp-stress-integrity"),
    evidenceRoot = `${harness.clusterPath}-swap-stress-evidence`
  try {
    const capture = await captureEnvelopeBaseline(harness.storageDir)
    if (capture.kind !== "captured")
      throw new TypeError("strict prepublication baseline capture failed")
    const baseline = { ...capture.baseline, artifactRefs: [] },
      persistence = await RunEvidencePersistence.allocate({
        clusterPath: harness.clusterPath,
        rampConfig: {
          initialCount: 1,
          multiplier: 2,
          maxCount: 1,
          phaseTimeoutMs: 1_000
        },
        requiredEndpoints: [RequiredEndpoint],
        provenance: {
          wireBuildPath: Path.resolve(harness.clusterPath, "wire-build"),
          ethereumPath: Path.resolve(harness.clusterPath, "wire-ethereum"),
          solanaPath: Path.resolve(harness.clusterPath, "wire-solana")
        },
        startedAtMs: StartedAtMs
      })
    await persistence.captureClusterConfig()
    await persistence.publishSetup({
      schemaVersion: RunEvidenceSchemaVersion,
      stage: RunEvidenceStage.Setup,
      status: RunEvidenceSetupStatus.Succeeded,
      startedAtMs: SetupStartedAtMs,
      endedAtMs: SetupEndedAtMs,
      clusterConfigCreated: true
    })

    const envelopeData = Envelope.toBinary(
        Envelope.create({
          epochIndex: Epoch,
          epochEnvelopeIndex: 1,
          epochTimestamp: BigInt(PhaseStartedAtMs),
          envelopeHash: new Uint8Array(32).fill(17),
          previousEnvelopeHash: new Uint8Array(32),
          messages: []
        })
      ),
      responses = await Promise.all([
        harness.rpc<PutEnvelopeResponse>(
          ApiPaths.OPP.Methods.Envelope,
          routePutParams(envelopeData, Operators[0])
        ),
        harness.rpc<PutEnvelopeResponse>(
          ApiPaths.OPP.Methods.Envelope,
          routePutParams(envelopeData, Operators[1])
        ),
        harness.rpc<PutEnvelopeResponse>(
          ApiPaths.OPP.Methods.Envelope,
          routePutParams(envelopeData, Operators[0])
        )
      ]),
      key = responses[0]?.body.result?.key
    if (key === undefined) throw new TypeError("route publication key expected")
    const metadata = DebugEnvelopeMetadataRecord.fromBinary(
        Fs.readFileSync(Path.join(harness.storageDir, `${key}.metadata`))
      ),
      metrics = await collectOppPhaseMetrics(harness.clusterPath, {
        phase: "http-rollover",
        startedAtMs: PhaseStartedAtMs,
        endedAtMs: PhaseEndedAtMs,
        epochStart: Epoch,
        epochEnd: Epoch,
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        saturationStrategy: "rollover",
        baseline,
        evidenceSink: persistence
      })
    if (
      metrics.evidence.kind !== "recorded" ||
      metrics.health.kind !== OppEnvelopeTelemetryHealthKind.Healthy
    )
      throw new TypeError("healthy recorded phase metrics expected")
    const evidence = metrics.evidence,
      phase = {
        status: RunEvidencePhaseStatus.Completed,
        label: metrics.phase,
        endpoint: metrics.endpoint,
        strategy: metrics.strategy,
        baseline: evidence.baseline,
        window: metrics.window,
        artifactRefs: evidence.artifactRefs,
        telemetry: metrics.health,
        metrics: {
          txSuccesses: 1,
          txFailures: 0,
          envelopeCount: metrics.envelopeCount,
          envelopeByteSizes: metrics.envelopeByteSizes,
          epochEnvelopeIndexes: metrics.epochEnvelopeIndexes,
          solanaOversized: metrics.solanaOversized,
          saturated: metrics.saturated
        }
      } as const,
      iterationRef = await persistence.publishIteration({
        schemaVersion: RunEvidenceSchemaVersion,
        stage: RunEvidenceStage.Iteration,
        iterationIndex: 0,
        accountCount: 1,
        startedAtMs: PhaseStartedAtMs,
        endedAtMs: PhaseEndedAtMs,
        outcome: RunEvidenceIterationOutcome.Saturated,
        requiredEndpoints: [RequiredEndpoint],
        saturatedEndpoints: [RequiredEndpoint],
        missingEndpoints: [],
        endpointResults: [
          {
            endpoint: RequiredEndpoint,
            telemetry: metrics.health,
            saturated: true
          }
        ],
        telemetry: metrics.health,
        phases: [phase]
      })
    await persistence.publishTerminal({
      schemaVersion: RunEvidenceSchemaVersion,
      stage: RunEvidenceStage.Terminal,
      lifecycle: RunEvidenceLifecycle.Saturated,
      startedAtMs: StartedAtMs,
      endedAtMs: TerminalEndedAtMs,
      requiredEndpoints: [RequiredEndpoint],
      saturatedEndpoints: [RequiredEndpoint],
      missingEndpoints: [],
      endpointResults: [
        {
          endpoint: RequiredEndpoint,
          telemetry: metrics.health,
          saturated: true
        }
      ],
      telemetry: metrics.health,
      iterationRefs: [iterationRef],
      preserveCluster: false
    })
    return {
      harness,
      evidenceRoot,
      key,
      metadata,
      metrics,
      evidence,
      persistence,
      responses
    }
  } catch (error) {
    try {
      await harness.stop()
    } finally {
      Fs.rmSync(evidenceRoot, { recursive: true, force: true })
    }
    throw error
  }
}

/**
 * Stop the live server and remove both cluster and external evidence roots.
 * @param fixture Test-owned completed run to dispose.
 */
export async function cleanupCompletedRun(
  fixture: CompletedRunFixture
): Promise<void> {
  try {
    await fixture.harness.stop()
  } finally {
    Fs.rmSync(fixture.evidenceRoot, { recursive: true, force: true })
  }
}
