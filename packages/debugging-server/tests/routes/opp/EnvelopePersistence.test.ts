import * as Fs from "node:fs"

import { EnvelopePersistence } from "@wireio/debugging-server/routes/opp"
import { AtomicFile } from "@wireio/debugging-shared"

import {
  createStorageDir,
  expectFiles,
  expectReadablePair,
  fixture,
  removeStorageDir,
  request
} from "./envelopePersistenceTestSupport.js"

describe("EnvelopePersistence core publication", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it("publishes a new immutable data and metadata pair", async () => {
    const storage = fixture(storageDir)

    const result = await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.a")
    )

    expect(result).toEqual({
      key: storage.key,
      dataExisted: false,
      batchOpNames: ["operator.a"]
    })
    await expectReadablePair(storageDir, storage, ["operator.a"])
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("reports a duplicate without replacing immutable data", async () => {
    const storage = fixture(storageDir)
    await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.a")
    )
    const originalData = await Fs.promises.readFile(storage.dataFile)

    const result = await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.a")
    )

    expect(result.dataExisted).toBe(true)
    expect(result.batchOpNames).toEqual(["operator.a"])
    expect(await Fs.promises.readFile(storage.dataFile)).toEqual(originalData)
    await expectReadablePair(storageDir, storage, ["operator.a"])
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("preserves insertion order while merging sequential operator names", async () => {
    const storage = fixture(storageDir)

    await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.a")
    )
    await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.b")
    )
    const result = await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.a")
    )

    expect(result.batchOpNames).toEqual(["operator.a", "operator.b"])
    await expectReadablePair(storageDir, storage, ["operator.a", "operator.b"])
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("serializes barrier-controlled concurrent writers and retains every unique name once", async () => {
    const storage = fixture(storageDir),
      enteredCreate = Promise.withResolvers<void>(),
      releaseCreate = Promise.withResolvers<void>(),
      names = [
        "operator.a",
        "operator.b",
        "operator.a",
        "operator.c",
        "operator.b",
        "operator.d",
        "operator.d",
        "operator.c"
      ] as const
    let createCalls = 0
    const dependencies: EnvelopePersistence.Dependencies = {
        create: async publishRequest => {
          createCalls += 1
          if (createCalls === 1) {
            enteredCreate.resolve()
            await releaseCreate.promise
          }
          return AtomicFile.create(publishRequest)
        }
      },
      writes = names.map(name =>
        EnvelopePersistence.persist(
          request(storageDir, storage.data, name),
          dependencies
        )
      )

    await enteredCreate.promise
    expect(createCalls).toBe(1)
    releaseCreate.resolve()
    const results = await Promise.all(writes)

    expect(results.filter(result => !result.dataExisted)).toHaveLength(1)
    expect(results.filter(result => result.dataExisted)).toHaveLength(7)
    await expectReadablePair(storageDir, storage, [
      "operator.a",
      "operator.b",
      "operator.c",
      "operator.d"
    ])
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })

  it("repairs a valid data-only orphan on retry", async () => {
    const storage = fixture(storageDir)
    await AtomicFile.create({ finalFile: storage.dataFile, data: storage.data })

    const result = await EnvelopePersistence.persist(
      request(storageDir, storage.data, "operator.repair")
    )

    expect(result.dataExisted).toBe(true)
    await expectReadablePair(storageDir, storage, ["operator.repair"])
    expectFiles(storageDir, [`${storage.key}.data`, `${storage.key}.metadata`])
  })
})
