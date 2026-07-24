import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"

import {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
  serializeRunEvidenceJson
} from "@wireio/test-opp-stress"

import { verifierFixtureSha256 } from "./runEvidenceVerifierArtifactFixture.js"
import type {
  VerifierFixture,
  VerifierFixtureOptions
} from "./runEvidenceVerifierFixtureTypes.js"
import {
  buildVerifierManifest,
  defaultVerifierPhases
} from "./runEvidenceVerifierManifestFixture.js"
import { buildVerifierRecords } from "./runEvidenceVerifierRecordFixture.js"

export type {
  VerifierFixture,
  VerifierFixtureOptions,
  VerifierPhaseSpec
} from "./runEvidenceVerifierFixtureTypes.js"

/** Build a canonical schema-v1 run from generated raw OPP bytes. */
export function createVerifierFixture(
  options: VerifierFixtureOptions = {}
): VerifierFixture {
  const runDirectory = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "run-evidence-verifier-")
    ),
    lifecycle = options.lifecycle ?? RunEvidenceLifecycle.Saturated,
    requiredEndpoints = options.requiredEndpoints ?? [
      RunEvidenceEndpoint.DepotOutpostEthereum
    ],
    phases =
      options.phases ?? defaultVerifierPhases(lifecycle, requiredEndpoints),
    initialCount = options.initialCount ?? 3,
    maxCount = options.maxCount ?? initialCount,
    accountCount = options.accountCount ?? initialCount
  Fs.mkdirSync(Path.join(runDirectory, RunEvidencePath.Iterations))
  Fs.mkdirSync(Path.join(runDirectory, RunEvidencePath.Artifacts), {
    recursive: true
  })
  const records = buildVerifierRecords(runDirectory, {
      lifecycle,
      requiredEndpoints,
      phases,
      accountCount,
      configCreatedBeforeSetupFailure:
        options.configCreatedBeforeSetupFailure ?? false,
      ...(options.breakagePhaseTelemetry === undefined
        ? {}
        : { breakagePhaseTelemetry: options.breakagePhaseTelemetry })
    }),
    manifest = buildVerifierManifest({
      lifecycle,
      requiredEndpoints,
      initialCount,
      maxCount,
      records
    })
  writeCanonical(Path.join(runDirectory, RunEvidencePath.Manifest), manifest)
  return {
    runDirectory,
    cleanup: () => Fs.rmSync(runDirectory, { recursive: true, force: true })
  }
}

/** Read one fixture JSON file as a mutable unknown record. */
export function readVerifierJson(
  runDirectory: string,
  relativePath: string
): Record<string, unknown> {
  const value: unknown = JSON.parse(
    Fs.readFileSync(Path.join(runDirectory, relativePath), "utf8")
  )
  if (!isUnknownRecord(value))
    throw new Error("verifier fixture JSON must be an object")
  return value
}

/** Rewrite one fixture record with canonical bytes. */
export function writeVerifierJson(
  runDirectory: string,
  relativePath: string,
  value: unknown
): void {
  writeCanonical(Path.join(runDirectory, relativePath), value)
}

/** Refresh one manifest record digest after a deliberate canonical mutation. */
export function refreshVerifierRecordHash(
  runDirectory: string,
  relativePath: string
): void {
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    records = objectField(manifest, "records"),
    digest = verifierFixtureSha256(
      Fs.readFileSync(Path.join(runDirectory, relativePath))
    )
  if (relativePath === RunEvidencePath.Setup)
    records["setup"] = { path: relativePath, sha256: digest }
  else if (relativePath === RunEvidencePath.Terminal)
    records["terminal"] = { path: relativePath, sha256: digest }
  else {
    const iterations = records["iterations"]
    if (!Array.isArray(iterations))
      throw new Error("iteration refs are required")
    const index = Number(Path.basename(relativePath, ".json"))
    iterations[index] = { path: relativePath, sha256: digest }
  }
  writeVerifierJson(runDirectory, RunEvidencePath.Manifest, manifest)
}

/** Narrow one fixture object field for deliberate mutation helpers. */
export function objectField(
  record: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const value = record[field]
  if (!isUnknownRecord(value))
    throw new Error(`fixture field ${field} must be an object`)
  return value
}

/** Narrow one unknown fixture value to a mutable object. */
export function recordValue(value: unknown): Record<string, unknown> {
  if (!isUnknownRecord(value))
    throw new Error("fixture value must be an object")
  return value
}

/** Narrow one fixture array field for deliberate mutation helpers. */
export function arrayField(
  record: Record<string, unknown>,
  field: string
): unknown[] {
  const value = record[field]
  if (!Array.isArray(value))
    throw new Error(`fixture field ${field} must be an array`)
  return value
}

/** Narrow one fixture string field for filesystem mutation helpers. */
export function stringField(
  record: Record<string, unknown>,
  field: string
): string {
  const value = record[field]
  if (typeof value !== "string")
    throw new Error(`fixture field ${field} must be a string`)
  return value
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function writeCanonical(file: string, value: unknown): void {
  Fs.writeFileSync(file, serializeRunEvidenceJson(value))
}
