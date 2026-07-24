import { createHash } from "node:crypto"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"
import { RunEvidencePersistence } from "@wireio/test-opp-stress"

import {
  successfulSetup,
  TestEndpoint
} from "./runEvidencePersistenceLifecycleFixtures.js"

export {
  breakageIteration,
  failedSetup,
  failedTerminal,
  setupFailedTerminal,
  successfulSetup,
  terminalRecord,
  TestEndpoint,
  iterationRecord
} from "./runEvidencePersistenceLifecycleFixtures.js"

/** Deterministic run identity used by persistence tests. */
export const TestRunId = "12345678-1234-4abc-8def-123456789abc"

/** Raw envelope bytes shared by valid artifact fixtures. */
export const TestDataBytes = Buffer.from(
  Envelope.toBinary(Envelope.create({ epochIndex: 1, epochEnvelopeIndex: 0 }))
)

/** Temporary roots and fixed source paths for one persistence scenario. */
export type PersistenceWorkspace = {
  readonly root: string
  readonly evidenceRoot: string
  readonly clusterPath: string
  readonly oppRoot: string
  readonly configBytes: Buffer
  readonly cleanup: () => void
}

/** Create isolated evidence, cluster-config, and OPP source directories. */
export function createPersistenceWorkspace(): PersistenceWorkspace {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "run-evidence-")),
    clusterPath = Path.join(root, "cluster"),
    evidenceRoot = `${clusterPath}-swap-stress-evidence`,
    oppRoot = Path.join(clusterPath, "data", "opp-debugging"),
    configBytes = Buffer.from(
      '{"exact":"cluster-config","large":"9007199254740993"}\n'
    )
  Fs.mkdirSync(oppRoot, { recursive: true })
  Fs.writeFileSync(Path.join(clusterPath, "cluster-config.json"), configBytes)
  return {
    root,
    evidenceRoot,
    clusterPath,
    oppRoot,
    configBytes,
    cleanup: () => Fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Build allocation input with deterministic runtime identity. */
export function allocationOptions(
  workspace: PersistenceWorkspace
): RunEvidencePersistence.AllocationOptions {
  return {
    clusterPath: workspace.clusterPath,
    rampConfig: {
      initialCount: 3,
      multiplier: 3,
      maxCount: 243,
      phaseTimeoutMs: 240_000
    },
    requiredEndpoints: [TestEndpoint],
    provenance: {
      wireBuildPath: Path.join(workspace.root, "wire-build"),
      ethereumPath: Path.join(workspace.root, "wire-ethereum"),
      solanaPath: Path.join(workspace.root, "wire-solana")
    },
    startedAtMs: "100"
  }
}

/** Build deterministic allocation collaborators, optionally overriding source I/O. */
export function allocationDependencies(
  sourceFileSystem?: Partial<RunEvidencePersistence.SourceFileSystem>
): RunEvidencePersistence.Dependencies {
  return {
    randomUUID: () => TestRunId,
    runtime: {
      nodeVersion: "v24.0.0",
      platform: "linux",
      architecture: "x64"
    },
    sourceFileSystem
  }
}

/** Allocate a run, capture config, and publish successful setup. */
export async function allocateRunningPersistence(
  workspace: PersistenceWorkspace,
  dependencies = allocationDependencies()
): Promise<RunEvidencePersistence> {
  const persistence = await RunEvidencePersistence.allocate(
    allocationOptions(workspace),
    dependencies
  )
  await persistence.captureClusterConfig()
  await persistence.publishSetup(successfulSetup())
  return persistence
}

/** Write one exact OPP data/metadata source pair and return its canonical key. */
export function writeOppPair(
  sourceRoot: string,
  batchOpNames: readonly string[],
  dataBytes: Uint8Array = TestDataBytes
): string {
  const checksum = sha256(dataBytes).slice(0, 16),
    baseKey = `00000001-DEPOT_OUTPOST_ETHEREUM-${checksum}`,
    metadataBytes = oppMetadataBytes(batchOpNames, dataBytes)
  Fs.mkdirSync(sourceRoot, { recursive: true })
  Fs.writeFileSync(Path.join(sourceRoot, `${baseKey}.data`), dataBytes)
  Fs.writeFileSync(Path.join(sourceRoot, `${baseKey}.metadata`), metadataBytes)
  return baseKey
}

/** Encode valid metadata for exact data bytes and ordered batch operators. */
export function oppMetadataBytes(
  batchOpNames: readonly string[],
  dataBytes: Uint8Array = TestDataBytes
): Buffer {
  const checksum = sha256(dataBytes).slice(0, 16)
  return Buffer.from(
    DebugEnvelopeMetadataRecord.toBinary({
      checksum: BigInt(`0x${checksum.slice(0, 12)}`),
      batchOpNames: [...batchOpNames]
    })
  )
}

/** Build one artifact request from exact fixture bytes. */
export function artifactCapture(
  sourceRoot: string,
  baseKey: string
): RunEvidencePersistence.ArtifactCapture {
  return {
    baseKey,
    dataBytes: Fs.readFileSync(Path.join(sourceRoot, `${baseKey}.data`)),
    metadataBytes: Fs.readFileSync(Path.join(sourceRoot, `${baseKey}.metadata`))
  }
}

/** Return the full lowercase SHA-256 digest of exact bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Read and parse one JSON evidence file. */
export function readJson(file: string): unknown {
  return JSON.parse(Fs.readFileSync(file, "utf8"))
}
