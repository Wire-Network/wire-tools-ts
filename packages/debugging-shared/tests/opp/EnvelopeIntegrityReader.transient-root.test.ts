import * as Fs from "node:fs"
import * as Path from "node:path"

import { DebugEnvelopeMetadataRecord } from "@wireio/opp-typescript-models"
import {
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

describe("EnvelopeIntegrityReader transient root containment", () => {
  it("rejects attacker sidecars served during a root swap restored before final verification", async () => {
    const container = createStorageDir(),
      storageDir = Path.join(container, "storage"),
      originalDir = Path.join(container, "original"),
      attackerDir = Path.join(container, "attacker")
    try {
      Fs.mkdirSync(storageDir)
      Fs.mkdirSync(attackerDir)
      const original = writeEnvelopePair(storageDir),
        attacker = writeEnvelopePair(attackerDir)
      Fs.writeFileSync(
        attacker.metadataPath,
        DebugEnvelopeMetadataRecord.toBinary(
          DebugEnvelopeMetadataRecord.create({
            checksum: BigInt(`0x${attacker.sha256.slice(0, 12)}`),
            batchOpNames: ["attacker"]
          })
        )
      )

      let sidecarOpenCount = 0,
        sidecarCloseCount = 0
      const result = await readEnvelopeIntegrity(
        storageDir,
        createEnvelopeBaseline([]),
        {
          fileSystem: createNodeFileSystem({
            beforeOpen: async () => {
              sidecarOpenCount += 1
              if (sidecarOpenCount === 1) {
                Fs.renameSync(storageDir, originalDir)
                Fs.symlinkSync(attackerDir, storageDir)
              }
            },
            afterClose: async () => {
              sidecarCloseCount += 1
              if (sidecarCloseCount === 4) {
                Fs.rmSync(storageDir)
                Fs.renameSync(originalDir, storageDir)
              }
            }
          })
        }
      )

      expect(sidecarOpenCount).toBe(4)
      expect(sidecarCloseCount).toBe(4)
      expect(result.valid).toEqual([])
      expect(result.valid.flatMap(value => value.batchOpNames)).not.toContain(
        "attacker"
      )
      expect(result.issues[0]?.code).toBe(
        EnvelopeIntegrityIssueCode.StorageRootChanged
      )
      expect(Fs.realpathSync(storageDir)).toBe(storageDir)
      expect(original.baseKey).toBe(attacker.baseKey)
    } finally {
      removeStorageDir(container)
    }
  })
})
