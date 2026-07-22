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
  removeStorageDir,
  writeEnvelopePair
} from "./envelopeIntegrityTestSupport.js"

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe("EnvelopeIntegrityReader serialized contracts", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it.each([
    1n,
    Symbol("thrown"),
    { nested: 2n },
    Object.defineProperties(new Error("hostile"), {
      name: { value: { nested: 3n } },
      message: { value: 4n },
      code: { value: Symbol("EHOSTILE") }
    }),
    Object.defineProperties(
      {},
      {
        name: {
          get: () => {
            throw 5n
          }
        },
        message: {
          get: () => {
            throw Symbol("message")
          }
        },
        code: {
          get: () => {
            throw { nested: 6n }
          }
        }
      }
    )
  ])("normalizes hostile thrown value %#", async thrown => {
    const result = await captureEnvelopeBaseline(storageDir, {
      fileSystem: createNodeFileSystem({
        readdir: async () => {
          throw thrown
        }
      })
    })

    expect(() => JSON.stringify(result)).not.toThrow()
    expect(roundTrip(result)).toEqual(result)
  })

  it("round-trips valid and corrupt decode results", async () => {
    const pair = writeEnvelopePair(storageDir),
      valid = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([])
      )
    expect(() => JSON.stringify(valid)).not.toThrow()
    Fs.writeFileSync(pair.dataPath, Buffer.from([0xff]))

    const corrupt = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    expect(corrupt.issues[0]?.code).toBe(
      EnvelopeIntegrityIssueCode.DataDecodeFailed
    )
    expect(() => JSON.stringify(corrupt)).not.toThrow()
    expect(roundTrip(corrupt)).toEqual(corrupt)
  })

  it("round-trips every closed issue-code variant", () => {
    Object.values(EnvelopeIntegrityIssueCode).forEach(code => {
      const issue = { code, baseKey: "$storage", context: { value: "safe" } }
      expect(roundTrip(issue)).toEqual(issue)
    })
  })

  it("orders Unicode candidates and issues by code units", async () => {
    ;["ä", "z", "a"].forEach(baseKey => {
      Fs.writeFileSync(Path.join(storageDir, `${baseKey}.data`), "bad")
    })

    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    expect(result.candidates).toEqual(["a", "z", "ä"])
    expect(result.issues.map(issue => issue.baseKey)).toEqual(["a", "z", "ä"])
  })

  it("reports injected candidate traversal before child I/O", async () => {
    const fileSystem = createNodeFileSystem({
        readdir: async () => ["../escape.data"]
      }),
      result = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([]),
        { fileSystem }
      )

    expect(result.issues[0]?.code).toBe(
      EnvelopeIntegrityIssueCode.PathOutsideStorageRoot
    )
  })

  it("declares the OPP directory export and blocks private helper subpaths", () => {
    const manifest: unknown = JSON.parse(
      Fs.readFileSync(Path.resolve(__dirname, "../../package.json"), "utf8")
    )

    expect(manifest).toMatchObject({
      exports: {
        "./opp": {
          types: "./lib/esm/opp/index.d.ts",
          import: "./lib/esm/opp/index.js",
          require: "./lib/cjs/opp/index.js"
        },
        "./opp/envelopeIntegrityError": null,
        "./opp/envelopeBaseline": null,
        "./opp/envelopeIntegrityFileIdentity": null,
        "./opp/envelopeIntegrityFileSystem": null,
        "./opp/envelopeIntegrityIssues": null,
        "./opp/envelopeIntegrityReaderFailure": null,
        "./opp/envelopeIntegrityRoot": null,
        "./opp/envelopeIntegrityRootTypes": null,
        "./opp/envelopeIntegrityRootVerification": null,
        "./opp/envelopeIntegritySidecarScan": null,
        "./opp/envelopeIntegritySnapshot": null,
        "./opp/envelopeIntegrityValidation": null,
        "./opp/envelopeIntegrityValidationTypes": null,
        "./opp/envelopeIntegrityWorkerPool": null
      }
    })
  })
})
