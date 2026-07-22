import * as Fs from "node:fs"

import { EnvelopePersistence } from "@wireio/debugging-server/routes/opp"
import { AtomicFile } from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType
} from "@wireio/opp-typescript-models"

import {
  captureIntegrityError,
  createStorageDir,
  errno,
  expectFiles,
  fixture,
  makeEnvelope,
  removeStorageDir,
  request
} from "./envelopePersistenceTestSupport.js"

describe("EnvelopePersistence integrity", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it("rejects malformed existing data without publishing metadata", async () => {
    const storage = fixture(storageDir)
    await AtomicFile.create({
      finalFile: storage.dataFile,
      data: Uint8Array.from([255])
    })

    const error = await captureIntegrityError(() =>
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.a")
      )
    )

    expect(error.kind).toBe(
      EnvelopePersistence.IntegrityErrorKind.ExistingDataMalformed
    )
    expectFiles(storageDir, [`${storage.key}.data`])
  })

  it("rejects an existing envelope with a different decoded epoch", async () => {
    const storage = fixture(storageDir)
    await AtomicFile.create({
      finalFile: storage.dataFile,
      data: makeEnvelope(43)
    })

    const error = await captureIntegrityError(() =>
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.a")
      )
    )

    expect(error.kind).toBe(
      EnvelopePersistence.IntegrityErrorKind.ExistingEpochMismatch
    )
    expectFiles(storageDir, [`${storage.key}.data`])
  })

  it("rejects existing bytes whose full hash and canonical key do not match", async () => {
    const storage = fixture(storageDir)
    await AtomicFile.create({
      finalFile: storage.dataFile,
      data: makeEnvelope(42, 1)
    })

    const error = await captureIntegrityError(() =>
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.a")
      )
    )

    expect(error.kind).toBe(
      EnvelopePersistence.IntegrityErrorKind.ExistingHashMismatch
    )
    expectFiles(storageDir, [`${storage.key}.data`])
  })

  it("rejects an endpoint that cannot form a canonical storage key", async () => {
    const storage = fixture(storageDir)

    const error = await captureIntegrityError(() =>
      EnvelopePersistence.persist({
        ...request(storageDir, storage.data, "operator.a"),
        endpointsType: DebugOutpostEndpointsType.UNKNOWN
      })
    )

    expect(error.kind).toBe(
      EnvelopePersistence.IntegrityErrorKind.InvalidStorageKey
    )
    expectFiles(storageDir, [])
  })

  it("rejects malformed metadata without resetting or replacing its bytes", async () => {
    const storage = fixture(storageDir),
      malformed = Uint8Array.from([255])
    await AtomicFile.create({ finalFile: storage.dataFile, data: storage.data })
    await AtomicFile.create({
      finalFile: storage.metadataFile,
      data: malformed
    })

    const error = await captureIntegrityError(() =>
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.a")
      )
    )

    expect(error.kind).toBe(
      EnvelopePersistence.IntegrityErrorKind.MetadataMalformed
    )
    expect(await Fs.promises.readFile(storage.metadataFile)).toEqual(
      Buffer.from(malformed)
    )
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("propagates unreadable metadata without changing its committed bytes", async () => {
    const storage = fixture(storageDir)
    await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.old")
    )
    const oldBytes = await Fs.promises.readFile(storage.metadataFile)

    await expect(
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.new"),
        {
          readFile: file =>
            file === storage.metadataFile
              ? Promise.reject(errno("EACCES"))
              : Fs.promises.readFile(file)
        }
      )
    ).rejects.toMatchObject({ code: "EACCES" })

    expect(await Fs.promises.readFile(storage.metadataFile)).toEqual(oldBytes)
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("rejects metadata with a mismatched checksum without changing it", async () => {
    const storage = fixture(storageDir),
      invalidMetadata = DebugEnvelopeMetadataRecord.toBinary(
        DebugEnvelopeMetadataRecord.create({
          checksum: 1n,
          batchOpNames: ["operator.old"]
        })
      )
    await AtomicFile.create({ finalFile: storage.dataFile, data: storage.data })
    await AtomicFile.create({
      finalFile: storage.metadataFile,
      data: invalidMetadata
    })

    const error = await captureIntegrityError(() =>
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.new")
      )
    )

    expect(error.kind).toBe(
      EnvelopePersistence.IntegrityErrorKind.MetadataChecksumMismatch
    )
    expect(await Fs.promises.readFile(storage.metadataFile)).toEqual(
      Buffer.from(invalidMetadata)
    )
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })
})
