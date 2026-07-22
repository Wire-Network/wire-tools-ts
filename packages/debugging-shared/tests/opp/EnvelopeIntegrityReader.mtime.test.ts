import * as Fs from "node:fs"

import {
  captureEnvelopeBaseline,
  readEnvelopeIntegrity
} from "@wireio/debugging-shared"

import {
  createStorageDir,
  removeStorageDir,
  writeEnvelopePair
} from "./envelopeIntegrityTestSupport.js"

describe("EnvelopeIntegrityReader descriptor mtimes", () => {
  it("reports stable descriptor mtimes without using them for membership", async () => {
    // Given: an empty baseline and one pair whose sidecar mtimes are changed.
    const storageDir = createStorageDir()
    try {
      const capture = await captureEnvelopeBaseline(storageDir)
      if (capture.kind !== "captured")
        throw new Error("baseline capture failed")
      const pair = writeEnvelopePair(storageDir)
      Fs.utimesSync(pair.dataPath, 2, 2)
      Fs.utimesSync(pair.metadataPath, 3, 3)
      const firstDataMtime = String(
          Fs.statSync(pair.dataPath, { bigint: true }).mtimeNs
        ),
        firstMetadataMtime = String(
          Fs.statSync(pair.metadataPath, { bigint: true }).mtimeNs
        )

      // When: the same baseline is reused before and after mtime-only changes.
      const first = await readEnvelopeIntegrity(storageDir, capture.baseline)
      Fs.utimesSync(pair.dataPath, 4, 4)
      Fs.utimesSync(pair.metadataPath, 5, 5)
      const second = await readEnvelopeIntegrity(storageDir, capture.baseline)

      // Then: membership is unchanged while diagnostics reflect each descriptor.
      expect(first.candidates).toEqual([pair.baseKey])
      expect(second.candidates).toEqual([pair.baseKey])
      expect(first.valid[0]).toMatchObject({
        dataMtimeNs: firstDataMtime,
        metadataMtimeNs: firstMetadataMtime
      })
      expect(second.valid[0]).toMatchObject({
        dataMtimeNs: String(
          Fs.statSync(pair.dataPath, { bigint: true }).mtimeNs
        ),
        metadataMtimeNs: String(
          Fs.statSync(pair.metadataPath, { bigint: true }).mtimeNs
        )
      })
    } finally {
      removeStorageDir(storageDir)
    }
  })
})
