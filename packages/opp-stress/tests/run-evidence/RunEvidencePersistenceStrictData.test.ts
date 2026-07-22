import Fs from "node:fs"
import Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  RunEvidencePath,
  RunEvidencePersistenceErrorCode,
  type RunEvidencePersistence
} from "@wireio/test-opp-stress"

import {
  allocateRunningPersistence,
  createPersistenceWorkspace,
  readJson,
  sha256
} from "./runEvidencePersistenceTestSupport.js"
import {
  duplicateFieldSaturationExploitBytes,
  DuplicateMetadataChecksumFieldNumber,
  prependDuplicateKnownField
} from "../duplicateProtobufFieldTestSupport.js"
import {
  appendUnknownLengthDelimitedField,
  unknownFieldSaturationExploitBytes,
  UnknownProtobufExploitByteLength
} from "../unknownProtobufFieldTestSupport.js"

type StrictBypassCase = {
  readonly label: string
  readonly dataBytes: Buffer
  readonly metadataBytes?: Buffer
}

const MetadataUnknownDataBytes = Buffer.from(
  Envelope.toBinary(Envelope.create({ epochIndex: 1 }))
)

const StrictBypassCases: readonly StrictBypassCase[] = [
  {
    label: "checksum-consistent malformed envelope protobuf",
    dataBytes: Buffer.from([0x0f])
  },
  {
    label: "valid envelope whose decoded epoch differs from its key",
    dataBytes: Buffer.from(
      Envelope.toBinary(
        Envelope.create({
          epochIndex: 2,
          epochEnvelopeIndex: 0
        })
      )
    )
  },
  {
    label: "62,378-byte hash-consistent unknown-field saturation envelope",
    dataBytes: unknownFieldSaturationExploitBytes(1)
  },
  {
    label: "62,377-byte hash-consistent duplicate-known-field saturation envelope",
    dataBytes: duplicateFieldSaturationExploitBytes(1)
  },
  {
    label: "metadata repeating its singular checksum field",
    dataBytes: MetadataUnknownDataBytes,
    metadataBytes: prependDuplicateKnownField(
      DebugEnvelopeMetadataRecord.toBinary({
        checksum: BigInt(`0x${sha256(MetadataUnknownDataBytes).slice(0, 12)}`),
        batchOpNames: ["operator.a"]
      }),
      DuplicateMetadataChecksumFieldNumber,
      1
    )
  },
  {
    label: "metadata containing an unknown field",
    dataBytes: MetadataUnknownDataBytes,
    metadataBytes: appendUnknownLengthDelimitedField(
      DebugEnvelopeMetadataRecord.toBinary({
        checksum: BigInt(
          `0x${sha256(MetadataUnknownDataBytes).slice(0, 12)}`
        ),
        batchOpNames: ["operator.a"]
      }),
      1
    )
  }
]

function strictBypassRequest(
  dataBytes: Buffer,
  metadataBytes?: Buffer
): RunEvidencePersistence.ArtifactCapture {
  const dataSha256 = sha256(dataBytes),
    baseKey = `00000001-DEPOT_OUTPOST_ETHEREUM-${dataSha256.slice(0, 16)}`
  return {
    baseKey,
    dataBytes,
    metadataBytes:
      metadataBytes ??
      Buffer.from(
        DebugEnvelopeMetadataRecord.toBinary({
          checksum: BigInt(`0x${dataSha256.slice(0, 12)}`),
          batchOpNames: ["operator.a"]
        })
      )
  }
}

describe("RunEvidencePersistence strict envelope data", () => {
  it.each(StrictBypassCases)(
    "rejects $label",
    async ({ dataBytes, metadataBytes }) => {
      // Given: a running persistence and internally checksum-consistent pair bytes.
      const workspace = createPersistenceWorkspace(),
        persistence = await allocateRunningPersistence(workspace),
        request = strictBypassRequest(dataBytes, metadataBytes)
      try {
        // When: direct capture attempts to bypass strict-reader data semantics.
        const capture = persistence
          .beginObservation("103")
          .captureArtifact(request)
        // Then: InvalidArtifact rejects before files or manifest state are published.
        await expect(capture).rejects.toMatchObject({
          name: "RunEvidencePersistenceError",
          code: RunEvidencePersistenceErrorCode.InvalidArtifact
        })
        expect(
          Fs.readdirSync(
            Path.join(persistence.runDirectory, RunEvidencePath.Artifacts)
          )
        ).toEqual([])
        expect(
          readJson(Path.join(persistence.runDirectory, RunEvidencePath.Manifest))
        ).toMatchObject({ artifacts: [] })
      } finally {
        workspace.cleanup()
      }
    }
  )

  it("keeps the unknown-field exploit fixture at the original raw threshold size", () => {
    expect(unknownFieldSaturationExploitBytes(1).byteLength).toBe(
      UnknownProtobufExploitByteLength
    )
  })
})
