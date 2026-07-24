import Path from "node:path"

import { AtomicFile } from "@wireio/debugging-shared"

import { OppEnvelopeTelemetryHealthKind } from "../envelopeMetricTypes.js"
import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import { canonicalEvidenceJson } from "./canonicalEvidenceJson.js"
import { RunEvidencePath } from "./runEvidenceConstants.js"
import { initialManifest } from "./runEvidenceManifestBuilders.js"
import { resolvePersistenceDependencies } from "./runEvidencePersistenceDependencies.js"
import {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./RunEvidencePersistenceError.js"
import { RunEvidencePersistenceStore } from "./RunEvidencePersistenceStore.js"
import { prepareRunDirectory } from "./safeEvidenceSource.js"

const CanonicalUuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Allocate and publish the initial durable state behind one persistence facade.
 * @param options Canonical cluster path and controller-owned run inputs.
 * @param dependencies Optional deterministic Node and AtomicFile seams.
 * @return Store whose parser-valid initializing manifest is durably published.
 */
export async function allocateRunEvidenceStore(
  options: RunEvidencePersistence.AllocationOptions,
  dependencies: RunEvidencePersistence.Dependencies
): Promise<RunEvidencePersistenceStore> {
  const resolved = resolvePersistenceDependencies(dependencies),
    runId = resolved.randomUUID()
  requireCanonicalRunId(runId)
  const allocation = await prepareRunDirectory(
      options.clusterPath,
      runId,
      resolved.sourceFileSystem
    ),
    manifest = initialManifest({
      runId,
      startedAtMs: options.startedAtMs,
      clusterPath: allocation.clusterPath,
      rampConfig: options.rampConfig,
      requiredEndpoints: options.requiredEndpoints,
      runtime: resolved.runtime,
      provenance: {
        wireBuildPath: Path.resolve(options.provenance.wireBuildPath),
        ethereumPath: Path.resolve(options.provenance.ethereumPath),
        solanaPath: Path.resolve(options.provenance.solanaPath)
      },
      telemetry: {
        kind: OppEnvelopeTelemetryHealthKind.Empty,
        retryable: true,
        candidateCount: 0,
        validCount: 0,
        filteredCount: 0,
        issueCount: 0,
        issues: []
      }
    }),
    manifestPublication = {
      finalFile: Path.join(allocation.runDirectory, RunEvidencePath.Manifest),
      data: canonicalEvidenceJson(manifest)
    }
  // This is the final await before atomic manifest publication begins.
  await allocation.revalidateClusterPath()
  await AtomicFile.create(manifestPublication, resolved.atomicFileDependencies)
  return new RunEvidencePersistenceStore({
    runDirectory: allocation.runDirectory,
    clusterPath: manifest.clusterPath,
    manifest,
    dependencies: resolved
  })
}

/**
 * Require the generated run identity to use canonical lowercase UUID-v4 form.
 * @param runId Generated identity to validate before filesystem allocation.
 */
function requireCanonicalRunId(runId: string): void {
  if (!CanonicalUuidV4.test(runId))
    throw new RunEvidencePersistenceError(
      RunEvidencePersistenceErrorCode.InvalidRunIdentity,
      `run identity is not a canonical lowercase UUID-v4: ${runId}`
    )
}
