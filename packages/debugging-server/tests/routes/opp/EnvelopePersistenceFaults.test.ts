import * as Fs from "node:fs"

import { EnvelopePersistence } from "@wireio/debugging-server/routes/opp"
import { AtomicFile } from "@wireio/debugging-shared"

import {
  capturePublishError,
  createStorageDir,
  directorySyncFault,
  errno,
  expectFiles,
  expectReadablePair,
  fixture,
  removeStorageDir,
  request
} from "./envelopePersistenceTestSupport.js"

describe("EnvelopePersistence atomic faults", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it("preserves old metadata bytes and reports diagnostics on pre-commit replace failure", async () => {
    const storage = fixture(storageDir)
    await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.old")
    )
    const oldBytes = await Fs.promises.readFile(storage.metadataFile),
      error = await capturePublishError(() =>
        EnvelopePersistence.persist(
          request(storageDir, storage.data, "operator.new"),
          {
            replace: publishRequest =>
              AtomicFile.replace(publishRequest, {
                fileSystem: { rename: () => Promise.reject(errno("EIO")) },
                tempToken: () => "metadata-precommit"
              })
          }
        )
      )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.Rename,
      finalFile: storage.metadataFile,
      residualTempFile: null
    })
    expect(await Fs.promises.readFile(storage.metadataFile)).toEqual(oldBytes)
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("surfaces committed post-commit failure while leaving complete new metadata", async () => {
    const storage = fixture(storageDir)
    await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.old")
    )

    const error = await capturePublishError(() =>
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.new"),
        {
          replace: publishRequest =>
            AtomicFile.replace(publishRequest, {
              fileSystem: directorySyncFault(),
              tempToken: () => "metadata-postcommit"
            })
        }
      )
    )

    expect(error).toMatchObject({
      committed: true,
      stage: AtomicFile.Stage.DirectorySync,
      finalFile: storage.metadataFile,
      residualTempFile: null
    })
    await expectReadablePair(storageDir, storage, [
      "operator.old",
      "operator.new"
    ])
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("continues a queued retry after an earlier entry rejects", async () => {
    const storage = fixture(storageDir)
    let replaceCalls = 0
    const dependencies: EnvelopePersistence.Dependencies = {
        replace: publishRequest => {
          replaceCalls += 1
          return AtomicFile.replace(
            publishRequest,
            replaceCalls === 1
              ? {
                  fileSystem: {
                    rename: () => Promise.reject(errno("EIO"))
                  },
                  tempToken: () => "queued-failure"
                }
              : {}
          )
        }
      },
      failed = EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.failed"),
        dependencies
      ),
      retry = EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.retry"),
        dependencies
      )

    const [failedResult, retryResult] = await Promise.allSettled([
      failed,
      retry
    ])

    expect(failedResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ committed: false })
    })
    expect(retryResult).toMatchObject({
      status: "fulfilled",
      value: expect.objectContaining({ dataExisted: true })
    })
    await expectReadablePair(storageDir, storage, ["operator.retry"])
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("cleans temporary files and leaves no finals after a pre-commit data failure", async () => {
    const storage = fixture(storageDir),
      error = await capturePublishError(() =>
        EnvelopePersistence.persist(
          request(storageDir, storage.data, "operator.a"),
          {
            create: publishRequest =>
              AtomicFile.create(publishRequest, {
                fileSystem: { link: () => Promise.reject(errno("EIO")) },
                tempToken: () => "data-precommit"
              })
          }
        )
      )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.Link,
      finalFile: storage.dataFile,
      residualTempFile: null
    })
    expectFiles(storageDir, [])
  })
})
