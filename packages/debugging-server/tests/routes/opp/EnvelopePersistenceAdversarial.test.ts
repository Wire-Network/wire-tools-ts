import * as Fs from "node:fs"
import * as Path from "node:path"

import { EnvelopePersistence } from "@wireio/debugging-server/routes/opp"
import { AtomicFile } from "@wireio/debugging-shared"

import {
  capturePublishError,
  createStorageDir,
  errno,
  expectFiles,
  fixture,
  removeStorageDir,
  request
} from "./envelopePersistenceTestSupport.js"

describe("EnvelopePersistence adversarial atomic diagnostics", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it.each([
    ["plain EEXIST object", errno("EEXIST")],
    [
      "uncommitted Rename/EEXIST PublishError",
      new AtomicFile.PublishError({
        stage: AtomicFile.Stage.Rename,
        finalFile: "lookalike",
        committed: false,
        residualTempFile: null,
        cause: errno("EEXIST")
      })
    ],
    [
      "committed Link/EEXIST PublishError",
      new AtomicFile.PublishError({
        stage: AtomicFile.Stage.Link,
        finalFile: "lookalike",
        committed: true,
        residualTempFile: null,
        cause: errno("EEXIST")
      })
    ]
  ])("rejects the %s lookalike", async (_name, injectedError) => {
    const storage = fixture(storageDir)

    await expect(
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.a"),
        { create: () => Promise.reject(injectedError) }
      )
    ).rejects.toBe(injectedError)

    expectFiles(storageDir, [])
  })

  it("rejects a symlinked storage parent without redirecting publication", async () => {
    const targetDir = Path.join(storageDir, "target"),
      linkedDir = Path.join(storageDir, "linked")
    Fs.mkdirSync(targetDir)
    Fs.symlinkSync(targetDir, linkedDir)
    const storage = fixture(linkedDir)

    const error = await capturePublishError(() =>
      EnvelopePersistence.persist(
        request(linkedDir, storage.data, "operator.a")
      )
    )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.Validate,
      finalFile: storage.dataFile,
      residualTempFile: null
    })
    expectFiles(targetDir, [])
    expectFiles(storageDir, ["linked", "target"])
  })

  it("rejects a symlink data final and preserves its target bytes", async () => {
    const storage = fixture(storageDir),
      targetFile = Path.join(storageDir, "target.data"),
      targetBytes = Buffer.from("authoritative-target")
    Fs.writeFileSync(targetFile, targetBytes)
    Fs.symlinkSync(targetFile, storage.dataFile)

    const error = await capturePublishError(() =>
      EnvelopePersistence.persist(
        request(storageDir, storage.data, "operator.a")
      )
    )

    expect(error).toMatchObject({
      committed: false,
      stage: AtomicFile.Stage.Validate,
      finalFile: storage.dataFile,
      residualTempFile: null
    })
    expect(Fs.readFileSync(targetFile)).toEqual(targetBytes)
    expectFiles(storageDir, [`${storage.key}.data`, "target.data"])
  })
})
