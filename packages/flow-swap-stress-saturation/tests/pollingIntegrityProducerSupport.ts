import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  createEnvelopeBaseline,
  readEnvelopeIntegrity
} from "@wireio/debugging-shared"
import type {
  EnvelopeIntegrityDirectoryHandle,
  EnvelopeIntegrityFileHandle,
  EnvelopeIntegrityFileSystem
} from "@wireio/debugging-shared"
import {
  mapEnvelopeIntegrityIssue,
  type OppEnvelopeTelemetryIssue
} from "@wireio/test-opp-stress"

const EndpointKey = "OUTPOST_ETHEREUM_DEPOT"

/** Canonical pair used to drive strict-reader issue producers. */
export type PollingEnvelopePair = {
  readonly baseKey: string
  readonly dataPath: string
  readonly metadataPath: string
  readonly dataBytes: Buffer
  readonly metadataBytes: Buffer
  readonly sha256: string
}

/** Typed overrides for one canonical producer pair. */
export type PollingEnvelopePairOptions = {
  readonly decodedEpoch?: number
  readonly keyEpoch?: number
  readonly metadataChecksum?: bigint
}

/** Mutable filesystem hooks applied around the real descriptor operations. */
export type PollingFileSystemHooks = {
  readonly readdir?: (
    path: string,
    read: () => Promise<readonly string[]>
  ) => Promise<readonly string[]>
  readonly openChild?: (
    basename: string,
    openCount: number,
    open: () => Promise<EnvelopeIntegrityFileHandle>
  ) => Promise<EnvelopeIntegrityFileHandle>
}

/**
 * Create an isolated producer workspace.
 * @param label Scenario label included in the temporary root.
 * @returns Absolute temporary directory.
 */
export function createProducerDirectory(label: string): string {
  return Fs.mkdtempSync(Path.join(Os.tmpdir(), `polling-${label}-`))
}

/**
 * Write one canonical data/metadata pair.
 * @param storageDir Strict-reader storage root.
 * @param options Epoch and metadata checksum overrides.
 * @returns Canonical pair paths, bytes, and digest.
 */
export function writePollingEnvelopePair(
  storageDir: string,
  options: PollingEnvelopePairOptions = {}
): PollingEnvelopePair {
  const decodedEpoch = options.decodedEpoch ?? 7,
    keyEpoch = options.keyEpoch ?? decodedEpoch,
    dataBytes = Buffer.from(
      Envelope.toBinary(
        Envelope.create({
          epochIndex: decodedEpoch,
          epochEnvelopeIndex: 0,
          epochTimestamp: 1n,
          envelopeHash: new Uint8Array(32),
          previousEnvelopeHash: new Uint8Array(32),
          messages: []
        })
      )
    ),
    sha256 = createHash("sha256").update(dataBytes).digest("hex"),
    baseKey = `${String(keyEpoch).padStart(8, "0")}-${EndpointKey}-${sha256.slice(0, 16)}`,
    metadataBytes = Buffer.from(
      DebugEnvelopeMetadataRecord.toBinary(
        DebugEnvelopeMetadataRecord.create({
          checksum:
            options.metadataChecksum ?? BigInt(`0x${sha256.slice(0, 12)}`),
          batchOpNames: ["batchop.producer"]
        })
      )
    ),
    dataPath = Path.join(storageDir, `${baseKey}.data`),
    metadataPath = Path.join(storageDir, `${baseKey}.metadata`)
  Fs.writeFileSync(dataPath, dataBytes)
  Fs.writeFileSync(metadataPath, metadataBytes)
  return { baseKey, dataPath, metadataPath, dataBytes, metadataBytes, sha256 }
}

/**
 * Read one exact issue through the real strict reader and production mapper.
 * @param storageDir Strict-reader storage root.
 * @param fileSystem Optional descriptor filesystem seam.
 * @returns Sole mapped telemetry issue.
 */
export async function readProducedIssue(
  storageDir: string,
  fileSystem: EnvelopeIntegrityFileSystem | null = null
): Promise<OppEnvelopeTelemetryIssue> {
  const result = await readEnvelopeIntegrity(
    storageDir,
    createEnvelopeBaseline([]),
    fileSystem === null ? {} : { fileSystem }
  )
  if (result.issues.length !== 1 || result.issues[0] === undefined)
    throw new TypeError(`producer returned ${result.issues.length} issues`)
  return mapEnvelopeIntegrityIssue(result.issues[0])
}

/**
 * Create a real no-follow Node filesystem with deterministic fault hooks.
 * @param hooks Descriptor scan/open hooks.
 * @returns Complete strict-reader filesystem implementation.
 */
export function createPollingFileSystem(
  hooks: PollingFileSystemHooks = {}
): EnvelopeIntegrityFileSystem {
  return {
    lstat: path => Fs.promises.lstat(path, { bigint: true }),
    realpath: path => Fs.promises.realpath(path),
    openDirectory: async path => {
      const handle = await Fs.promises.open(
          path,
          Fs.constants.O_RDONLY |
            Fs.constants.O_DIRECTORY |
            Fs.constants.O_NOFOLLOW
        ),
        openCounts = new Map<string, number>(),
        descriptorRoot = `/proc/self/fd/${handle.fd}`,
        directory: EnvelopeIntegrityDirectoryHandle = {
          stat: () => handle.stat({ bigint: true }),
          readFile: () => handle.readFile(),
          close: () => handle.close(),
          readdir: () =>
            hooks.readdir?.(path, () => Fs.promises.readdir(descriptorRoot)) ??
            Fs.promises.readdir(descriptorRoot),
          openChild: async basename => {
            const count = (openCounts.get(basename) ?? 0) + 1
            openCounts.set(basename, count)
            const open = async (): Promise<EnvelopeIntegrityFileHandle> => {
              const child = await Fs.promises.open(
                Path.join(descriptorRoot, basename),
                Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW
              )
              return {
                stat: () => child.stat({ bigint: true }),
                readFile: () => child.readFile(),
                close: () => child.close()
              }
            }
            return hooks.openChild?.(basename, count, open) ?? open()
          }
        }
      return directory
    }
  }
}

/**
 * Remove both sides of one canonical pair.
 * @param pair Pair whose files are removed.
 */
export function removePollingPair(pair: PollingEnvelopePair): void {
  Fs.rmSync(pair.dataPath, { recursive: true, force: true })
  Fs.rmSync(pair.metadataPath, { recursive: true, force: true })
}
