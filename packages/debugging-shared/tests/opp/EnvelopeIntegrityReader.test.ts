import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  captureEnvelopeBaseline,
  createEnvelopeBaseline,
  EnvelopeIntegrityIssueCode,
  readEnvelopeIntegrity
} from "@wireio/debugging-shared"

import {
  createNodeFileSystem,
  createStorageDir,
  EndpointKey,
  removeStorageDir,
  writeEnvelopePair
} from "./envelopeIntegrityTestSupport.js"

describe("EnvelopeIntegrityReader", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it("returns exact bytes and validated fields for a canonical pair", async () => {
    const pair = writeEnvelopePair(storageDir),
      result = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([])
      )

    expect(result.candidates).toEqual([pair.baseKey])
    expect(result.pending).toEqual([])
    expect(result.issues).toEqual([])
    expect(result.valid).toHaveLength(1)
    expect(result.valid[0]).toMatchObject({
      baseKey: pair.baseKey,
      epochIndex: 42,
      epochEnvelopeIndex: 0,
      dataSha256: pair.sha256,
      metadataChecksum: pair.sha256.slice(0, 12),
      batchOpNames: ["batchop.a"]
    })
    expect(Buffer.from(result.valid[0]?.dataBytes ?? [])).toEqual(
      pair.dataBytes
    )
    expect(Buffer.from(result.valid[0]?.metadataBytes ?? [])).toEqual(
      pair.metadataBytes
    )
  })

  it("reports both orphan directions as pending", async () => {
    const dataOnly = writeEnvelopePair(storageDir),
      metadataOnly = writeEnvelopePair(storageDir, { epochEnvelopeIndex: 1 })
    Fs.rmSync(dataOnly.metadataPath)
    Fs.rmSync(metadataOnly.dataPath)

    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    expect(result.pending).toEqual(
      [
        { baseKey: dataOnly.baseKey, missingSidecar: "metadata" },
        { baseKey: metadataOnly.baseKey, missingSidecar: "data" }
      ].sort((left, right) =>
        left.baseKey < right.baseKey ? -1 : left.baseKey > right.baseKey ? 1 : 0
      )
    )
    expect(result.issues.map(issue => issue.baseKey)).toEqual(
      [dataOnly.baseKey, metadataOnly.baseKey].sort()
    )
    expect(result.issues.map(issue => issue.code).sort()).toEqual(
      [
        EnvelopeIntegrityIssueCode.MissingMetadataSidecar,
        EnvelopeIntegrityIssueCode.MissingDataSidecar
      ].sort()
    )
  })

  it.each([
    ["bad", "invalid_storage_key"],
    [`42-${EndpointKey}-0123456789abcdef`, "invalid_storage_key"],
    [`00000042-UNKNOWN-0123456789abcdef`, "unknown_endpoint"],
    [`00000042-${EndpointKey}-0123456789abcdeF`, "invalid_storage_key"]
  ])("reports malformed candidate %s", async (baseKey, expectedCode) => {
    Fs.writeFileSync(Path.join(storageDir, `${baseKey}.data`), "x")
    Fs.writeFileSync(Path.join(storageDir, `${baseKey}.metadata`), "x")

    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.code).toBe(expectedCode)
  })

  it("excludes every canonical and invalid key captured from either suffix", async () => {
    const oldData = writeEnvelopePair(storageDir),
      oldMetadata = writeEnvelopePair(storageDir, { epochEnvelopeIndex: 1 })
    Fs.rmSync(oldData.metadataPath)
    Fs.rmSync(oldMetadata.dataPath)
    Fs.writeFileSync(Path.join(storageDir, "invalid.data"), "old")
    Fs.writeFileSync(Path.join(storageDir, "also-invalid.metadata"), "old")
    const capture = await captureEnvelopeBaseline(storageDir)
    if (capture.kind !== "captured") throw new Error("baseline capture failed")
    const added = writeEnvelopePair(storageDir, { epochEnvelopeIndex: 2 })

    const result = await readEnvelopeIntegrity(storageDir, capture.baseline)

    expect(capture.baseline.baseKeys).toEqual(
      ["also-invalid", oldData.baseKey, oldMetadata.baseKey, "invalid"].sort()
    )
    expect(result.candidates).toEqual([added.baseKey])
  })

  it("sorts candidates, valid pairs, pending pairs, and issues", async () => {
    const valid = writeEnvelopePair(storageDir, { epochEnvelopeIndex: 2 }),
      pending = writeEnvelopePair(storageDir, { epochEnvelopeIndex: 1 })
    Fs.rmSync(pending.metadataPath)
    Fs.writeFileSync(Path.join(storageDir, "zzz.data"), "bad")
    const filenames = (await Fs.promises.readdir(storageDir)).reverse()

    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([]),
      { fileSystem: createNodeFileSystem({ readdir: async () => filenames }) }
    )

    expect(result.candidates).toEqual([...result.candidates].sort())
    expect(result.valid.map(record => record.baseKey)).toEqual([valid.baseKey])
    expect(result.pending.map(record => record.baseKey)).toEqual([
      pending.baseKey
    ])
    expect(result.issues.map(issue => issue.baseKey)).toEqual(
      [...result.issues.map(issue => issue.baseKey)].sort()
    )
  })

  it("returns normalized baseline, scan, and candidate read failures", async () => {
    const scanError = Object.assign(new Error("scan denied"), {
        code: "EACCES"
      }),
      failedFileSystem = createNodeFileSystem({
        readdir: async () => {
          throw scanError
        }
      }),
      capture = await captureEnvelopeBaseline(storageDir, {
        fileSystem: failedFileSystem
      }),
      scan = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([]),
        { fileSystem: failedFileSystem }
      )
    expect(capture).toMatchObject({
      kind: "failed",
      issues: [
        {
          code: EnvelopeIntegrityIssueCode.BaselineCaptureFailed,
          context: { error: { code: "EACCES", message: "scan denied" } }
        }
      ]
    })
    expect(scan.issues[0]?.code).toBe(
      EnvelopeIntegrityIssueCode.DirectoryScanFailed
    )

    const pair = writeEnvelopePair(storageDir),
      read = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([]),
        {
          fileSystem: createNodeFileSystem({
            beforeOpen: async file => {
              if (file === pair.dataPath) {
                throw Object.assign(new Error("read denied"), {
                  code: "EACCES"
                })
              }
            }
          })
        }
      )
    expect(read.issues[0]).toMatchObject({
      code: EnvelopeIntegrityIssueCode.DataReadFailed,
      context: { error: { code: "EACCES", operation: "open" } }
    })
  })
})
