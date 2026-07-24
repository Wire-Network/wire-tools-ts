import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  endpointsTypeToKey,
  EnvelopeRecordFile
} from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"

/** Default epoch used by strict metric fixtures. */
export const MetricEpoch = 7

/** Default endpoint direction used by strict metric fixtures. */
export const MetricEndpointsType =
  DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT

/** Written strict metric fixture and its canonical paths. */
export type MetricEnvelopeFixture = {
  readonly baseKey: string
  readonly dataPath: string
  readonly metadataPath: string
  readonly dataBytes: Buffer
  readonly sha256: string
}

/** Overrides for one strict metric fixture. */
export type MetricEnvelopeFixtureOptions = {
  readonly endpointsType?: DebugOutpostEndpointsType
  readonly keyEpoch?: number
  readonly decodedEpoch?: number
  readonly payloadSize?: number
  readonly metadataChecksum?: bigint
}

/**
 * Create one disposable OPP metric storage directory.
 *
 * @param label Human-readable fixture label.
 * @returns Absolute temporary directory path.
 */
export function makeMetricStorageDir(label: string): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), `opp-stress-metrics-${label}-`))
}

/**
 * Remove one disposable OPP metric storage directory.
 *
 * @param storageDir Temporary directory to remove.
 */
export function removeMetricStorageDir(storageDir: string): void {
  Fs.rmSync(storageDir, { recursive: true, force: true })
}

/**
 * Write one checksum-correct envelope and metadata pair.
 *
 * @param storageDir Fixture storage directory.
 * @param epochEnvelopeIndex Decoded rollover index.
 * @param options Endpoint, epoch, payload, and checksum overrides.
 * @returns Canonical key, paths, bytes, and full data digest.
 */
export function writeMetricEnvelopeFixture(
  storageDir: string,
  epochEnvelopeIndex: number,
  options: MetricEnvelopeFixtureOptions = {}
): MetricEnvelopeFixture {
  const endpointsType = options.endpointsType ?? MetricEndpointsType,
    keyEpoch = options.keyEpoch ?? MetricEpoch,
    decodedEpoch = options.decodedEpoch ?? keyEpoch,
    payload = new Uint8Array(options.payloadSize ?? 0)
  payload.fill(1)
  const envelope = Envelope.create({
      epochIndex: decodedEpoch,
      epochEnvelopeIndex,
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
    dataBytes = Buffer.from(Envelope.toBinary(envelope)),
    sha256 = createHash("sha256").update(dataBytes).digest("hex"),
    endpointsKey = endpointsTypeToKey(endpointsType)
  if (endpointsKey === null) {
    throw new Error("Metric fixture endpoint must resolve to a storage key")
  }
  const baseKey = `${String(keyEpoch).padStart(8, "0")}-${endpointsKey}-${sha256.slice(0, 16)}`,
    dataPath = Path.join(storageDir, `${baseKey}${EnvelopeRecordFile.DataExt}`),
    metadataPath = Path.join(
      storageDir,
      `${baseKey}${EnvelopeRecordFile.MetadataExt}`
    )
  Fs.writeFileSync(dataPath, dataBytes)
  Fs.writeFileSync(
    metadataPath,
    DebugEnvelopeMetadataRecord.toBinary(
      DebugEnvelopeMetadataRecord.create({
        checksum:
          options.metadataChecksum ?? BigInt(`0x${sha256.slice(0, 12)}`),
        batchOpNames: ["batchop.a"]
      })
    )
  )
  return { baseKey, dataPath, metadataPath, dataBytes, sha256 }
}

/**
 * Write one invalid candidate pair under an arbitrary base key.
 *
 * @param storageDir Fixture storage directory.
 * @param baseKey Invalid or canonical-looking base key.
 */
export function writeInvalidMetricPair(
  storageDir: string,
  baseKey: string
): void {
  Fs.writeFileSync(
    Path.join(storageDir, `${baseKey}${EnvelopeRecordFile.DataExt}`),
    Buffer.from([0xff])
  )
  Fs.writeFileSync(
    Path.join(storageDir, `${baseKey}${EnvelopeRecordFile.MetadataExt}`),
    Buffer.from([0xff])
  )
}
