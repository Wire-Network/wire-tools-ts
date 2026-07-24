import * as Fs from "node:fs"
import * as Path from "node:path"

import type { EnvelopeIntegrityFileSystem } from "@wireio/debugging-shared"
import type { OppEnvelopeTelemetryIssue } from "@wireio/test-opp-stress"

import {
  createPollingFileSystem,
  createProducerDirectory,
  readProducedIssue,
  writePollingEnvelopePair
} from "./pollingIntegrityProducerSupport.js"

/**
 * Produce every storage-scoped post-baseline issue through the strict reader.
 * @returns Six production-mapped root and scan issues.
 */
export async function produceRootPollingIssues(): Promise<
  readonly OppEnvelopeTelemetryIssue[]
> {
  const producers = [
    produceRootSymlink,
    produceAncestorSymlink,
    produceRootNotDirectory,
    produceRootChanged,
    produceRootReadFailure,
    produceDirectoryScanFailure
  ]
  return producers.reduce<Promise<readonly OppEnvelopeTelemetryIssue[]>>(
    async (produced, produce) => [...(await produced), await produce()],
    Promise.resolve([])
  )
}

async function produceRootSymlink(): Promise<OppEnvelopeTelemetryIssue> {
  const container = createProducerDirectory("root-symlink"),
    target = Path.join(container, "target"),
    link = Path.join(container, "storage")
  try {
    Fs.mkdirSync(target)
    writePollingEnvelopePair(target)
    Fs.symlinkSync(target, link)
    return await readProducedIssue(link)
  } finally {
    Fs.rmSync(container, { recursive: true, force: true })
  }
}

async function produceAncestorSymlink(): Promise<OppEnvelopeTelemetryIssue> {
  const container = createProducerDirectory("ancestor-symlink"),
    targetParent = Path.join(container, "target-parent"),
    target = Path.join(targetParent, "storage"),
    linkParent = Path.join(container, "linked-parent")
  try {
    Fs.mkdirSync(targetParent)
    Fs.mkdirSync(target)
    writePollingEnvelopePair(target)
    Fs.symlinkSync(targetParent, linkParent)
    return await readProducedIssue(Path.join(linkParent, "storage"))
  } finally {
    Fs.rmSync(container, { recursive: true, force: true })
  }
}

async function produceRootNotDirectory(): Promise<OppEnvelopeTelemetryIssue> {
  const container = createProducerDirectory("root-file"),
    file = Path.join(container, "storage")
  try {
    Fs.writeFileSync(file, "not-a-directory")
    return await readProducedIssue(file)
  } finally {
    Fs.rmSync(container, { recursive: true, force: true })
  }
}

async function produceRootChanged(): Promise<OppEnvelopeTelemetryIssue> {
  const container = createProducerDirectory("root-changed"),
    storageDir = Path.join(container, "storage"),
    original = Path.join(container, "original")
  Fs.mkdirSync(storageDir)
  writePollingEnvelopePair(storageDir)
  let replaced = false
  try {
    const fileSystem = createPollingFileSystem({
      readdir: async (_path, read) => {
        const files = await read()
        if (!replaced) {
          Fs.renameSync(storageDir, original)
          Fs.mkdirSync(storageDir)
          writePollingEnvelopePair(storageDir)
          replaced = true
        }
        return files
      }
    })
    return await readProducedIssue(storageDir, fileSystem)
  } finally {
    Fs.rmSync(container, { recursive: true, force: true })
  }
}

async function produceRootReadFailure(): Promise<OppEnvelopeTelemetryIssue> {
  const storageDir = createProducerDirectory("root-read"),
    base = createPollingFileSystem(),
    fileSystem: EnvelopeIntegrityFileSystem = {
      ...base,
      lstat: path =>
        path === storageDir
          ? Promise.reject(Object.assign(new Error("root_lstat"), { code: "EIO" }))
          : base.lstat(path)
    }
  try {
    return await readProducedIssue(storageDir, fileSystem)
  } finally {
    Fs.rmSync(storageDir, { recursive: true, force: true })
  }
}

async function produceDirectoryScanFailure(): Promise<OppEnvelopeTelemetryIssue> {
  const storageDir = createProducerDirectory("scan")
  writePollingEnvelopePair(storageDir)
  try {
    return await readProducedIssue(
      storageDir,
      createPollingFileSystem({
        readdir: async () => {
          throw Object.assign(new Error("readdir"), { code: "EIO" })
        }
      })
    )
  } finally {
    Fs.rmSync(storageDir, { recursive: true, force: true })
  }
}
