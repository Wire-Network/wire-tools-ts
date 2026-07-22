import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"
import type {
  EnvelopeIntegrityDirectoryHandle,
  EnvelopeIntegrityFileHandle,
  EnvelopeIntegrityFileStat,
  EnvelopeIntegrityFileSystem
} from "@wireio/debugging-shared"

/** Canonical endpoint token used by strict-reader fixtures. */
export const EndpointKey = "OUTPOST_ETHEREUM_DEPOT"

/** Complete on-disk pair and its expected validation values. */
export type EnvelopePairFixture = {
  readonly baseKey: string
  readonly dataPath: string
  readonly metadataPath: string
  readonly dataBytes: Buffer
  readonly metadataBytes: Buffer
  readonly sha256: string
}

/** Overrides used to construct malformed or edge-case pairs. */
export type EnvelopePairOptions = {
  readonly keyEpoch?: number
  readonly decodedEpoch?: number
  readonly epochEnvelopeIndex?: number
  readonly metadataChecksum?: bigint
}

/** Hooks around descriptor-bound reads for deterministic race tests. */
export type EnvelopeFileSystemHooks = {
  readonly readdir?: (
    storageDir: string,
    read: () => Promise<readonly string[]>
  ) => Promise<readonly string[]>
  readonly beforeOpen?: (file: string) => Promise<void>
  readonly afterRead?: (file: string) => Promise<void>
  readonly afterClose?: (file: string) => Promise<void>
  readonly rootStat?: (
    context: EnvelopeRootStatHookContext
  ) => Promise<EnvelopeIntegrityFileStat>
  readonly rootClose?: (context: EnvelopeRootCloseHookContext) => Promise<void>
}

/** Descriptor-root stat hook context for deterministic verification faults. */
export type EnvelopeRootStatHookContext = {
  readonly path: string
  readonly openCount: number
  readonly statCount: number
  readonly stat: EnvelopeIntegrityFileStat
}

/** Descriptor-root close hook context for deterministic close faults. */
export type EnvelopeRootCloseHookContext = {
  readonly path: string
  readonly openCount: number
  readonly close: () => Promise<void>
}

/**
 * Create one disposable storage directory.
 * @returns Absolute temporary directory path.
 */
export function createStorageDir(): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), "envelope-integrity-"))
}

/**
 * Dispose a fixture directory recursively.
 * @param storageDir Temporary directory to remove.
 */
export function removeStorageDir(storageDir: string): void {
  Fs.rmSync(storageDir, { recursive: true, force: true })
}

/**
 * Write a valid pair, optionally separating key and decoded epochs.
 * @param storageDir Fixture storage directory.
 * @param options Pair construction overrides.
 * @returns Paths, bytes, key, and digest for the pair.
 */
export function writeEnvelopePair(
  storageDir: string,
  options: EnvelopePairOptions = {}
): EnvelopePairFixture {
  const keyEpoch = options.keyEpoch ?? 42,
    decodedEpoch = options.decodedEpoch ?? keyEpoch,
    dataBytes = Buffer.from(
      Envelope.toBinary(
        Envelope.create({
          epochIndex: decodedEpoch,
          epochEnvelopeIndex: options.epochEnvelopeIndex ?? 0,
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
          batchOpNames: ["batchop.a"]
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
 * Find a deterministic envelope whose SHA-256 prefix starts with zero.
 * @param storageDir Fixture storage directory.
 * @returns Written leading-zero pair.
 */
export function writeLeadingZeroPair(storageDir: string): EnvelopePairFixture {
  const epochEnvelopeIndex = Array.from({ length: 4_096 }, (_, index) => index)
    .map(index => ({
      index,
      bytes: Buffer.from(
        Envelope.toBinary(
          Envelope.create({
            epochIndex: 42,
            epochEnvelopeIndex: index,
            epochTimestamp: 1n,
            envelopeHash: new Uint8Array(32),
            previousEnvelopeHash: new Uint8Array(32),
            messages: []
          })
        )
      )
    }))
    .find(candidate =>
      createHash("sha256").update(candidate.bytes).digest("hex").startsWith("0")
    )?.index
  if (epochEnvelopeIndex === undefined) {
    throw new Error("Deterministic leading-zero envelope fixture was not found")
  }
  return writeEnvelopePair(storageDir, { epochEnvelopeIndex })
}

/**
 * Adapt real Node handles to the reader seam with deterministic hooks.
 * @param hooks Optional scan/open/read barriers.
 * @returns Complete typed filesystem seam.
 */
export function createNodeFileSystem(
  hooks: EnvelopeFileSystemHooks = {}
): EnvelopeIntegrityFileSystem {
  let rootOpenCount = 0
  return {
    lstat: path => Fs.promises.lstat(path, { bigint: true }),
    realpath: path => Fs.promises.realpath(path),
    openDirectory: async path => {
      const handle = await Fs.promises.open(
        path,
        Fs.constants.O_RDONLY |
          Fs.constants.O_DIRECTORY |
          Fs.constants.O_NOFOLLOW
      )
      rootOpenCount += 1
      return wrapDirectory(path, handle, rootOpenCount, hooks)
    }
  }
}

function wrapDirectory(
  path: string,
  handle: Fs.promises.FileHandle,
  openCount: number,
  hooks: EnvelopeFileSystemHooks
): EnvelopeIntegrityDirectoryHandle {
  const descriptorRoot = `/proc/self/fd/${handle.fd}`
  let statCount = 0
  return {
    stat: async () => {
      const stat = await handle.stat({ bigint: true })
      statCount += 1
      return (
        hooks.rootStat?.({ path, openCount, statCount, stat }) ??
        Promise.resolve(stat)
      )
    },
    readFile: () => handle.readFile(),
    close: () =>
      hooks.rootClose?.({
        path,
        openCount,
        close: () => handle.close()
      }) ?? handle.close(),
    readdir: () =>
      hooks.readdir?.(path, () => Fs.promises.readdir(descriptorRoot)) ??
      Fs.promises.readdir(descriptorRoot),
    openChild: async basename => {
      const file = Path.join(path, basename)
      await hooks.beforeOpen?.(file)
      return wrapHandle(
        file,
        await Fs.promises.open(
          Path.join(descriptorRoot, basename),
          Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW
        ),
        hooks
      )
    }
  }
}

function wrapHandle(
  file: string,
  handle: Fs.promises.FileHandle,
  hooks: EnvelopeFileSystemHooks
): EnvelopeIntegrityFileHandle {
  return {
    stat: () => handle.stat({ bigint: true }),
    readFile: async () => {
      const bytes = await handle.readFile()
      await hooks.afterRead?.(file)
      return bytes
    },
    close: () => handle.close().then(() => hooks.afterClose?.(file))
  }
}
