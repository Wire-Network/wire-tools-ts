import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  createEnvelopeBaseline,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidencePhaseStatus,
  RunEvidenceSchemaVersion,
  RunEvidenceStage,
  parseRunEvidenceIteration
} from "@wireio/test-opp-stress"

import { writeMetricEnvelopeFixture } from "./oppEnvelopeMetricTestSupport.js"
import {
  allocateRunningPersistence,
  createPersistenceWorkspace,
  sha256
} from "./run-evidence/runEvidencePersistenceTestSupport.js"

describe("collectOppPhaseMetrics immutable evidence", () => {
  it("preserves selected exact bytes and constructs a parser-valid phase", async () => {
    // Given: one post-baseline valid pair and a real running evidence sink.
    const workspace = createPersistenceWorkspace(),
      baseline = { ...createEnvelopeBaseline([]), artifactRefs: [] },
      persistence = await allocateRunningPersistence(workspace),
      fixture = writeMetricEnvelopeFixture(workspace.oppRoot, 1),
      metadataBytes = Fs.readFileSync(fixture.metadataPath),
      dataMtimeNs = String(
        Fs.statSync(fixture.dataPath, { bigint: true }).mtimeNs
      ),
      metadataMtimeNs = String(
        Fs.statSync(fixture.metadataPath, { bigint: true }).mtimeNs
      )
    try {
      // When: the generic collector records the selected phase artifact.
      const result = await collectOppPhaseMetrics(workspace.clusterPath, {
        phase: "immutable-phase",
        startedAtMs: "100",
        endedAtMs: "200",
        epochStart: 7,
        epochEnd: 7,
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        baseline,
        evidenceSink: persistence
      })
      if (
        result.evidence.kind !== "recorded" ||
        result.health.kind !== OppEnvelopeTelemetryHealthKind.Healthy
      )
        throw new Error("healthy recorded phase expected")
      const captured = result.evidence.artifacts[0]
      if (captured === undefined) throw new Error("captured artifact expected")
      Fs.writeFileSync(fixture.dataPath, "mutated")
      Fs.rmSync(fixture.dataPath)
      Fs.rmSync(fixture.metadataPath)

      // Then: immutable refs stay exact and expose complete verification inputs.
      expect(result.selectedArtifacts).toEqual([
        {
          baseKey: fixture.baseKey,
          epoch: 7,
          index: 1,
          dataSha256: fixture.sha256,
          dataMtimeNs,
          metadataMtimeNs
        }
      ])
      expect(
        Fs.readFileSync(
          Path.join(persistence.runDirectory, captured.immutableRefs.data.path)
        )
      ).toEqual(fixture.dataBytes)
      expect(
        Fs.readFileSync(
          Path.join(
            persistence.runDirectory,
            captured.immutableRefs.metadata.path
          )
        )
      ).toEqual(metadataBytes)
      expect(captured.immutableRefs.data.sha256).toBe(sha256(fixture.dataBytes))
      expect(result.evidence.artifactRefs).toEqual([
        captured.immutableRefs.data.path,
        captured.immutableRefs.metadata.path
      ])

      const phase = {
          status: RunEvidencePhaseStatus.Completed,
          label: result.phase,
          endpoint: result.endpoint,
          strategy: result.strategy,
          baseline: result.evidence.baseline,
          window: result.window,
          artifactRefs: result.evidence.artifactRefs,
          telemetry: result.health,
          metrics: {
            txSuccesses: 1,
            txFailures: 0,
            envelopeCount: result.envelopeCount,
            envelopeByteSizes: result.envelopeByteSizes,
            epochEnvelopeIndexes: result.epochEnvelopeIndexes,
            solanaOversized: result.solanaOversized,
            saturated: result.saturated
          }
        },
        iteration = {
          schemaVersion: RunEvidenceSchemaVersion,
          stage: RunEvidenceStage.Iteration,
          iterationIndex: 0,
          accountCount: 1,
          startedAtMs: "100",
          endedAtMs: "200",
          outcome: RunEvidenceIterationOutcome.Saturated,
          requiredEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot],
          saturatedEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot],
          missingEndpoints: [],
          endpointResults: [
            {
              endpoint: RunEvidenceEndpoint.OutpostEthereumDepot,
              telemetry: result.health,
              saturated: true
            }
          ],
          telemetry: result.health,
          phases: [phase]
        }
      expect(parseRunEvidenceIteration(iteration)).toEqual({
        ok: true,
        value: iteration
      })
    } finally {
      workspace.cleanup()
    }
  })
})
