import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"

import {
  createEnvelopeBaseline,
  endpointsTypeToKey,
  EnvelopeRecordFile
} from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceEndpoint,
  RunEvidencePath,
  collectOppPhaseMetrics,
  parseRunEvidenceManifest,
  parseRunEvidenceTerminal,
  type RunEvidencePersistence
} from "@wireio/test-opp-stress"
import {
  projectOppPhaseMetrics,
  type SwapStressIterationObservation,
  type SwapStressPhaseResult
} from "@wireio/test-flow-swap-stress-saturation"

/** Fixed schema-v1 run identity used by focused lifecycle tests. */
export const LifecycleRunId = "12345678-1234-4abc-8def-123456789abc"

/** Isolated cluster and external evidence paths for one lifecycle branch. */
export type LifecycleWorkspace = {
  readonly root: string
  readonly clusterPath: string
  readonly configPath: string
  readonly oppPath: string
  readonly cleanup: () => void
}

/** Create an empty intended cluster path beneath an isolated real parent. */
export function createLifecycleWorkspace(): LifecycleWorkspace {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "real-stress-lifecycle-")),
    clusterPath = Path.join(root, "cluster"),
    configPath = Path.join(clusterPath, "cluster-config.json"),
    oppPath = Path.join(clusterPath, "data", "opp-debugging")
  return {
    root,
    clusterPath,
    configPath,
    oppPath,
    cleanup: () => Fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Deterministic allocation dependencies for one focused lifecycle run. */
export function lifecycleAllocationDependencies(): RunEvidencePersistence.Dependencies {
  return {
    randomUUID: () => LifecycleRunId,
    runtime: {
      nodeVersion: "v-test",
      platform: "test",
      architecture: "test"
    }
  }
}

/** Create exact cluster config bytes and the canonical OPP source directory. */
export function createClusterConfig(workspace: LifecycleWorkspace): void {
  Fs.mkdirSync(workspace.oppPath, { recursive: true })
  Fs.writeFileSync(workspace.configPath, "{\"cluster\":\"test\"}\n")
}

/** Read the public parser-valid manifest from one allocated run. */
export function readLifecycleManifest(runDirectory: string) {
  const parsed = parseRunEvidenceManifest(
    JSON.parse(
      Fs.readFileSync(Path.join(runDirectory, RunEvidencePath.Manifest), "utf8")
    )
  )
  if ("error" in parsed) throw new Error("lifecycle manifest must parse")
  return parsed.value
}

/** Read the public parser-valid terminal from one finalized run. */
export function readLifecycleTerminal(runDirectory: string) {
  const parsed = parseRunEvidenceTerminal(
    JSON.parse(
      Fs.readFileSync(Path.join(runDirectory, RunEvidencePath.Terminal), "utf8")
    )
  )
  if ("error" in parsed) throw new Error("lifecycle terminal must parse")
  return parsed.value
}

/** Build one artifact-backed saturated flow observation through public collectors. */
export async function saturatedObservation(
  workspace: LifecycleWorkspace,
  persistence: RunEvidencePersistence
): Promise<SwapStressIterationObservation> {
  return artifactBackedObservation(workspace, persistence, 64_000)
}

/** Build one artifact-backed completed observation below saturation thresholds. */
export async function nonSaturatedObservation(
  workspace: LifecycleWorkspace,
  persistence: RunEvidencePersistence
): Promise<SwapStressIterationObservation> {
  return artifactBackedObservation(workspace, persistence, 64)
}

async function artifactBackedObservation(
  workspace: LifecycleWorkspace,
  persistence: RunEvidencePersistence,
  payloadSize: number
): Promise<SwapStressIterationObservation> {
  writeEnvelope(
    workspace.oppPath,
    DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
    payloadSize
  )
  writeEnvelope(
    workspace.oppPath,
    DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
    payloadSize
  )
  const first = await phaseResult(
      workspace,
      persistence,
      "phase-1",
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
    ),
    second = await phaseResult(
      workspace,
      persistence,
      "phase-2",
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    )
  return {
    kind: "completed",
    saturatedEndpoints: [
      ...(first.saturated
        ? [RunEvidenceEndpoint.OutpostEthereumDepot]
        : []),
      ...(second.saturated
        ? [RunEvidenceEndpoint.DepotOutpostEthereum]
        : [])
    ],
    observedNonRequiredEndpoints: [],
    evidence: { phaseResults: [first, second], telemetryDegradation: null }
  }
}

async function phaseResult(
  workspace: LifecycleWorkspace,
  persistence: RunEvidencePersistence,
  phase: string,
  endpointsType: DebugOutpostEndpointsType
): Promise<SwapStressPhaseResult> {
  const metrics = await collectOppPhaseMetrics(workspace.clusterPath, {
    phase,
    startedAtMs: "10",
    endedAtMs: "20",
    epochStart: 1,
    epochEnd: 1,
    endpointsType,
    baseline: {
      ...createEnvelopeBaseline([]),
      artifactRefs: []
    },
    evidenceSink: persistence
  })
  if (metrics.health.kind !== OppEnvelopeTelemetryHealthKind.Healthy)
    throw new Error("fixture telemetry must be healthy")
  return {
    ...projectOppPhaseMetrics({ ...metrics, health: metrics.health }),
    txSuccesses: 1,
    txFailures: 0,
    observationStartedAtMs: 10,
    observationEndedAtMs: 20,
    payout: null
  }
}

function writeEnvelope(
  storagePath: string,
  endpointsType: DebugOutpostEndpointsType,
  payloadSize: number
): void {
  Fs.mkdirSync(storagePath, { recursive: true })
  const payload = new Uint8Array(payloadSize)
  payload.fill(1)
  const envelope = Envelope.create({
      epochIndex: 1,
      epochEnvelopeIndex: payloadSize >= 64_000 ? 1 : 0,
      epochTimestamp: 1_000n,
      envelopeHash: new Uint8Array(32),
      previousEnvelopeHash: new Uint8Array(32),
      messages: [
        {
          payload: {
            version: 0,
            attestations: [
              {
                type: AttestationType.UNSPECIFIED,
                dataSize: payload.length,
                data: payload
              }
            ]
          }
        }
      ]
    }),
    data = Buffer.from(Envelope.toBinary(envelope)),
    digest = createHash("sha256").update(data).digest("hex"),
    endpoint = endpointsTypeToKey(endpointsType)
  if (endpoint === null) throw new Error("fixture endpoint must be canonical")
  const base = `${"1".padStart(8, "0")}-${endpoint}-${digest.slice(0, 16)}`
  Fs.writeFileSync(Path.join(storagePath, `${base}${EnvelopeRecordFile.DataExt}`), data)
  Fs.writeFileSync(
    Path.join(storagePath, `${base}${EnvelopeRecordFile.MetadataExt}`),
    DebugEnvelopeMetadataRecord.toBinary(
      DebugEnvelopeMetadataRecord.create({
        checksum: BigInt(`0x${digest.slice(0, 12)}`),
        batchOpNames: ["batchop.a"]
      })
    )
  )
}
