import * as Fs from "node:fs"
import * as Path from "node:path"

import type { OppEnvelopeTelemetryIssue } from "@wireio/test-opp-stress"

import {
  createPollingFileSystem,
  createProducerDirectory,
  readProducedIssue,
  removePollingPair,
  writePollingEnvelopePair,
  type PollingEnvelopePair
} from "./pollingIntegrityProducerSupport.js"

/**
 * Produce every candidate-scoped post-baseline issue through the strict reader.
 * @returns Eighteen production-mapped candidate issues.
 */
export async function produceCandidatePollingIssues(): Promise<
  readonly OppEnvelopeTelemetryIssue[]
> {
  const producers = [
    produceMalformedKey,
    produceUnknownEndpoint,
    () => produceMissingSidecar("data"),
    () => produceMissingSidecar("metadata"),
    () => produceSidecarShape("data", "symlink"),
    () => produceSidecarShape("metadata", "symlink"),
    () => produceSidecarShape("data", "directory"),
    () => produceSidecarShape("metadata", "directory"),
    () => produceSidecarFault("data", "read"),
    () => produceSidecarFault("metadata", "read"),
    () => produceSidecarFault("data", "changed"),
    () => produceSidecarFault("metadata", "changed"),
    () => produceDecodeFailure("data"),
    () => produceDecodeFailure("metadata"),
    produceHashMismatch,
    produceChecksumMismatch,
    produceEpochMismatch,
    producePathEscape
  ]
  return producers.reduce<Promise<readonly OppEnvelopeTelemetryIssue[]>>(
    async (produced, produce) => [...(await produced), await produce()],
    Promise.resolve([])
  )
}

async function produceMalformedKey(): Promise<OppEnvelopeTelemetryIssue> {
  return withPair("invalid-key", async (storageDir, pair) => {
    removePollingPair(pair)
    Fs.writeFileSync(Path.join(storageDir, "bad.data"), "bad")
    Fs.writeFileSync(Path.join(storageDir, "bad.metadata"), "bad")
    return readProducedIssue(storageDir)
  })
}

async function produceUnknownEndpoint(): Promise<OppEnvelopeTelemetryIssue> {
  return withPair("unknown-endpoint", async (storageDir, pair) => {
    removePollingPair(pair)
    const baseKey = "00000007-UNKNOWN-0123456789abcdef"
    Fs.writeFileSync(Path.join(storageDir, `${baseKey}.data`), "bad")
    Fs.writeFileSync(Path.join(storageDir, `${baseKey}.metadata`), "bad")
    return readProducedIssue(storageDir)
  })
}

async function produceMissingSidecar(
  sidecar: "data" | "metadata"
): Promise<OppEnvelopeTelemetryIssue> {
  return withPair(`missing-${sidecar}`, async (storageDir, pair) => {
    Fs.rmSync(sidecarPath(pair, sidecar))
    return readProducedIssue(storageDir)
  })
}

async function produceSidecarShape(
  sidecar: "data" | "metadata",
  shape: "symlink" | "directory"
): Promise<OppEnvelopeTelemetryIssue> {
  return withPair(`${sidecar}-${shape}`, async (storageDir, pair) => {
    const path = sidecarPath(pair, sidecar)
    Fs.rmSync(path)
    if (shape === "directory") Fs.mkdirSync(path)
    else {
      const target = Path.join(storageDir, `${sidecar}-target`)
      Fs.writeFileSync(target, "target")
      Fs.symlinkSync(target, path)
    }
    return readProducedIssue(storageDir)
  })
}

async function produceSidecarFault(
  sidecar: "data" | "metadata",
  fault: "read" | "changed"
): Promise<OppEnvelopeTelemetryIssue> {
  return withPair(`${sidecar}-${fault}`, async (storageDir, pair) => {
    const target = Path.basename(sidecarPath(pair, sidecar)),
      fileSystem = createPollingFileSystem({
        openChild: async (basename, count, open) => {
          if (basename !== target) return open()
          if (fault === "changed" && count === 2)
            throw Object.assign(new Error("verify_open"), { code: "EIO" })
          const handle = await open()
          return fault === "read" && count === 1
            ? {
                ...handle,
                readFile: async () => {
                  throw Object.assign(new Error("read"), { code: "EIO" })
                }
              }
            : handle
        }
      })
    return readProducedIssue(storageDir, fileSystem)
  })
}

async function produceDecodeFailure(
  sidecar: "data" | "metadata"
): Promise<OppEnvelopeTelemetryIssue> {
  return withPair(`${sidecar}-decode`, async (storageDir, pair) => {
    Fs.writeFileSync(sidecarPath(pair, sidecar), Buffer.from([0xff]))
    return readProducedIssue(storageDir)
  })
}

async function produceHashMismatch(): Promise<OppEnvelopeTelemetryIssue> {
  return withPair("hash", async (storageDir, pair) => {
    const wrongKey = pair.baseKey.replace(/[0-9a-f]{16}$/, "0000000000000000")
    Fs.renameSync(pair.dataPath, Path.join(storageDir, `${wrongKey}.data`))
    Fs.renameSync(pair.metadataPath, Path.join(storageDir, `${wrongKey}.metadata`))
    return readProducedIssue(storageDir)
  })
}

async function produceChecksumMismatch(): Promise<OppEnvelopeTelemetryIssue> {
  const storageDir = createProducerDirectory("checksum")
  try {
    writePollingEnvelopePair(storageDir, { metadataChecksum: 2n })
    return await readProducedIssue(storageDir)
  } finally {
    Fs.rmSync(storageDir, { recursive: true, force: true })
  }
}

async function produceEpochMismatch(): Promise<OppEnvelopeTelemetryIssue> {
  const storageDir = createProducerDirectory("epoch")
  try {
    writePollingEnvelopePair(storageDir, { decodedEpoch: 8, keyEpoch: 7 })
    return await readProducedIssue(storageDir)
  } finally {
    Fs.rmSync(storageDir, { recursive: true, force: true })
  }
}

async function producePathEscape(): Promise<OppEnvelopeTelemetryIssue> {
  return withPair("escape", (storageDir, _pair) =>
    readProducedIssue(
      storageDir,
      createPollingFileSystem({ readdir: async () => ["../escape.data"] })
    )
  )
}

async function withPair(
  label: string,
  produce: (
    storageDir: string,
    pair: PollingEnvelopePair
  ) => Promise<OppEnvelopeTelemetryIssue>
): Promise<OppEnvelopeTelemetryIssue> {
  const storageDir = createProducerDirectory(label)
  try {
    return await produce(storageDir, writePollingEnvelopePair(storageDir))
  } finally {
    Fs.rmSync(storageDir, { recursive: true, force: true })
  }
}

function sidecarPath(
  pair: PollingEnvelopePair,
  sidecar: "data" | "metadata"
): string {
  return sidecar === "data" ? pair.dataPath : pair.metadataPath
}
