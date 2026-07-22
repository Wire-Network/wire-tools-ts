import { validateEnvelopeStorageKey } from "@wireio/debugging-shared"

import { RunEvidencePath } from "./runEvidenceConstants.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceArtifactFile,
  RunEvidenceImmutableArtifactRefs,
  RunEvidenceProvenance
} from "./RunEvidenceCoreTypes.js"
import {
  hasUniqueStrings,
  isAbsoluteNormalizedPath,
  isExactRecord,
  isNonEmptyString,
  isOrderedDecimals,
  isSha256,
  isSortedUniqueNames
} from "./runEvidencePrimitiveGuards.js"

enum ArtifactExtension {
  Data = ".data",
  Metadata = ".metadata"
}

/** Narrow an unknown value to a canonical immutable artifact entry. */
export function isArtifact(value: unknown): value is RunEvidenceArtifact {
  if (
    !isExactRecord(value, [
      "baseKey",
      "firstImmutableRefs",
      "firstAcceptedObservationOrdinal",
      "lastAcceptedObservationOrdinal",
      "lastAcceptedBatchOpNames"
    ]) ||
    !isCanonicalBaseKey(value.baseKey) ||
    !isImmutableArtifactRefs(value.firstImmutableRefs) ||
    !isOrderedDecimals(
      value.firstAcceptedObservationOrdinal,
      value.lastAcceptedObservationOrdinal
    ) ||
    !isSortedUniqueNames(value.lastAcceptedBatchOpNames)
  )
    return false
  return (
    value.firstImmutableRefs.data.path ===
      `${RunEvidencePath.Artifacts}/${value.baseKey}${ArtifactExtension.Data}` &&
    value.firstImmutableRefs.metadata.path ===
      `${RunEvidencePath.Artifacts}/${value.baseKey}${ArtifactExtension.Metadata}`
  )
}

/** Narrow an unknown value to unique canonical artifact entries. */
export function isArtifactEntries(
  value: unknown
): value is readonly RunEvidenceArtifact[] {
  if (!Array.isArray(value) || !value.every(isArtifact)) return false
  const keys = value.map(entry => entry.baseKey),
    refs = value.flatMap(entry => [
      entry.firstImmutableRefs.data.path,
      entry.firstImmutableRefs.metadata.path
    ])
  return hasUniqueStrings(keys) && hasUniqueStrings(refs)
}

/** Validate a portable run-relative OPP artifact ref. */
export function isArtifactRef(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\")) return false
  const segments = value.split("/")
  if (
    segments.length !== 3 ||
    `${segments[0]}/${segments[1]}` !== RunEvidencePath.Artifacts
  )
    return false
  const filename = segments[2]
  if (filename === undefined) return false
  const extension = filename.endsWith(ArtifactExtension.Metadata)
    ? ArtifactExtension.Metadata
    : filename.endsWith(ArtifactExtension.Data)
      ? ArtifactExtension.Data
      : null
  if (extension === null) return false
  return isCanonicalBaseKey(filename.slice(0, -extension.length))
}

/** Validate a unique array of portable artifact refs. */
export function isArtifactRefs(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(isArtifactRef) &&
    hasUniqueStrings(value)
  )
}

/** Narrow unknown input to absolute normalized provenance. */
export function isProvenance(value: unknown): value is RunEvidenceProvenance {
  return (
    isExactRecord(value, ["wireBuildPath", "ethereumPath", "solanaPath"]) &&
    isAbsoluteNormalizedPath(value.wireBuildPath) &&
    isAbsoluteNormalizedPath(value.ethereumPath) &&
    isAbsoluteNormalizedPath(value.solanaPath)
  )
}

function isCanonicalBaseKey(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    validateEnvelopeStorageKey(value).kind === "valid"
  )
}

function isImmutableArtifactRefs(
  value: unknown
): value is RunEvidenceImmutableArtifactRefs {
  return (
    isExactRecord(value, ["data", "metadata"]) &&
    isArtifactFile(value.data, ArtifactExtension.Data) &&
    isArtifactFile(value.metadata, ArtifactExtension.Metadata) &&
    value.data.path !== value.metadata.path
  )
}

function isArtifactFile(
  value: unknown,
  extension: ArtifactExtension
): value is RunEvidenceArtifactFile {
  return (
    isExactRecord(value, ["path", "sha256"]) &&
    isArtifactRef(value.path) &&
    value.path.endsWith(extension) &&
    isSha256(value.sha256)
  )
}
