import * as Crypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"

import { AtomicFile } from "../utils/index.js"
import type {
  OppPhaseArtifactCapture,
  OppPhaseEvidenceObservation,
  OppPhaseEvidenceSink,
  RunEvidenceImmutableArtifactRefs
} from "./phaseMetricTypes.js"
import type { RunEvidenceDecimal } from "./oppPhaseVocabulary.js"

/**
 * Content-addressed OPP artifact capture, written next to the `Report`.
 *
 * This is what survives the run-evidence store. The store's schema, manifest,
 * lifecycle and terminal records all duplicated what the `Report` already
 * narrates, but its ARTIFACT capture did not: the Report has no immutability
 * or digest story, so the raw envelope bytes behind a saturation claim would
 * otherwise be unrecoverable once the cluster is reaped.
 *
 * Artifacts land under `<cluster>/reports/artifacts/opp/` — deliberately
 * inside the Report's own directory rather than the old disjoint
 * `<cluster>-swap-stress-evidence/` sibling, so one directory carries both the
 * narrative and the bytes it refers to.
 */
export namespace ReportArtifactSink {
  /** Subpath, under the report directory, holding captured OPP artifacts. */
  export const ArtifactSubpath = Path.join("artifacts", "opp")

  /** Extension for the raw serialized envelope bytes. */
  export const DataExtension = ".data"
  /** Extension for the sidecar metadata bytes. */
  export const MetadataExtension = ".metadata"

  /**
   * Create a sink writing content-addressed artifacts under `reportPath`.
   *
   * Capture is idempotent by construction: a pair is stored at a path derived
   * from the SHA-256 of its own bytes, so re-capturing the same envelope in a
   * later observation resolves to the same immutable file rather than a
   * conflicting second copy.
   *
   * @param reportPath - The cluster's report directory.
   * @returns A sink the phase-metric collector can capture into.
   */
  export function create(reportPath: string): OppPhaseEvidenceSink {
    const artifactRoot = Path.join(reportPath, ArtifactSubpath)
    let ordinal = 0n
    return {
      beginObservation: (): OppPhaseEvidenceObservation => {
        ordinal += 1n
        return {
          ordinal: `${ordinal}` as RunEvidenceDecimal,
          captureArtifact: request => capture(artifactRoot, request)
        }
      }
    }
  }

  async function capture(
    artifactRoot: string,
    request: OppPhaseArtifactCapture
  ): Promise<RunEvidenceImmutableArtifactRefs> {
    const data = await publish(
        artifactRoot,
        request.baseKey,
        DataExtension,
        request.dataBytes
      ),
      metadata = await publish(
        artifactRoot,
        request.baseKey,
        MetadataExtension,
        request.metadataBytes
      )
    return { data, metadata }
  }

  async function publish(
    artifactRoot: string,
    baseKey: string,
    extension: string,
    bytes: Buffer
  ): Promise<RunEvidenceImmutableArtifactRefs["data"]> {
    const sha256 = Crypto.createHash("sha256").update(bytes).digest("hex"),
      path = Path.join(artifactRoot, `${baseKey}-${sha256}${extension}`)
    await Fs.mkdir(artifactRoot, { recursive: true })
    // Content-addressed, so an existing destination necessarily holds these
    // exact bytes — re-capturing the same envelope in a later observation is a
    // no-op, not a collision. AtomicFile.create is create-only by design.
    if (!(await exists(path)))
      await AtomicFile.create({ finalFile: path, data: bytes })
    return { path, sha256 }
  }

  async function exists(path: string): Promise<boolean> {
    return Fs.access(path).then(
      () => true,
      () => false
    )
  }
}
