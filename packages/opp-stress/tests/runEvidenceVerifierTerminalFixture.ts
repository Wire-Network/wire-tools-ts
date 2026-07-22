import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppEnvelopeTelemetryHealthKind,
  RampBreakageCategory,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceSchemaVersion,
  RunEvidenceStage,
  serializeRunEvidenceJson,
  type RunEvidenceEndpoint
} from "@wireio/test-opp-stress"

import { verifierFixtureSha256 } from "./runEvidenceVerifierArtifactFixture.js"
import type {
  BuiltVerifierRecords,
  VerifierRecordBuildInput
} from "./runEvidenceVerifierFixtureTypes.js"

/** Write terminal evidence and return complete manifest-facing record state. */
export function buildTerminalVerifierRecords(
  runDirectory: string,
  input: VerifierRecordBuildInput,
  setupRef: { readonly path: string; readonly sha256: string },
  iterationRefs: readonly { readonly path: string; readonly sha256: string }[],
  artifacts: BuiltVerifierRecords["artifacts"],
  saturatedEndpoints: readonly RunEvidenceEndpoint[],
  telemetry: BuiltVerifierRecords["telemetry"],
  configSnapshot: unknown
): BuiltVerifierRecords {
  const missingEndpoints = input.requiredEndpoints.filter(
      endpoint => !saturatedEndpoints.includes(endpoint)
    ),
    terminal = terminalRecord(
      input.lifecycle,
      input.requiredEndpoints,
      saturatedEndpoints,
      missingEndpoints,
      telemetry,
      iterationRefs
    ),
    terminalRef = writeVerifierRecord(
      runDirectory,
      RunEvidencePath.Terminal,
      terminal
    )
  return {
    setupRef,
    iterationRefs,
    terminalRef,
    artifacts,
    saturatedEndpoints,
    telemetry,
    configSnapshot
  }
}

/** Write one canonical fixture record and return its exact digest ref. */
export function writeVerifierRecord(
  runDirectory: string,
  path: string,
  value: unknown
): { readonly path: string; readonly sha256: string } {
  const bytes = serializeRunEvidenceJson(value)
  Fs.writeFileSync(Path.join(runDirectory, path), bytes)
  return { path, sha256: verifierFixtureSha256(bytes) }
}

function terminalRecord(
  lifecycle: RunEvidenceLifecycle,
  requiredEndpoints: readonly RunEvidenceEndpoint[],
  saturatedEndpoints: readonly RunEvidenceEndpoint[],
  missingEndpoints: readonly RunEvidenceEndpoint[],
  telemetry: BuiltVerifierRecords["telemetry"],
  iterationRefs: readonly { readonly path: string; readonly sha256: string }[]
): unknown {
  const failed =
      lifecycle === RunEvidenceLifecycle.Failed ||
      lifecycle === RunEvidenceLifecycle.SetupFailed,
    base = {
      schemaVersion: RunEvidenceSchemaVersion,
      stage: RunEvidenceStage.Terminal,
      lifecycle,
      startedAtMs: "100",
      endedAtMs: "110",
      requiredEndpoints,
      saturatedEndpoints,
      missingEndpoints,
      endpointResults: requiredEndpoints.map(endpoint => ({
        endpoint,
        telemetry,
        saturated: saturatedEndpoints.includes(endpoint)
      })),
      telemetry,
      iterationRefs,
      preserveCluster: lifecycle !== RunEvidenceLifecycle.Saturated
    }
  return failed
    ? {
        ...base,
        breakageCategory:
          telemetry.kind === OppEnvelopeTelemetryHealthKind.Degraded
            ? RampBreakageCategory.TelemetryIntegrity
            : RampBreakageCategory.Infrastructure,
        breakageReason: "run failed"
      }
    : base
}
