import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as Path from "node:path"

import { WireType } from "@protobuf-ts/runtime"
import { DebugEnvelopeMetadataRecord } from "@wireio/opp-typescript-models"
import { match } from "ts-pattern"
import { createEnvelopeBaseline, EnvelopeIntegrityIssueCode, readEnvelopeIntegrity } from "@wireio/test-flow-swap-stress-saturation/envelope-integrity/index.js"

import {
  createStorageDir,
  removeStorageDir,
  writeEnvelopePair,
  writeLeadingZeroPair
} from "./envelopeIntegrityTestSupport.js"
import { encodeVarint } from "../unknownProtobufFieldTestSupport.js"

describe("EnvelopeIntegrityReader exact integrity failures", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = createStorageDir()
  })

  afterEach(() => {
    removeStorageDir(storageDir)
  })

  it.each([
    ["data", EnvelopeIntegrityIssueCode.DataDecodeFailed],
    ["metadata", EnvelopeIntegrityIssueCode.MetadataDecodeFailed]
  ])("retains exact %s protobuf failure without valid credit", async (sidecar, code) => {
    // Given: one canonical pair has corrupt bytes on the selected side.
    const pair = writeEnvelopePair(storageDir),
      path = sidecar === "data" ? pair.dataPath : pair.metadataPath
    Fs.writeFileSync(path, Buffer.from([0xff]))

    // When: strict validation reads the corrupted pair.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    // Then: exact correlation survives and no valid pair is credited.
    expect(result.valid).toEqual([])
    expect(result.issues).toEqual([
      {
        code,
        baseKey: pair.baseKey,
        context: { path, reason: "premature EOF" }
      }
    ])
  })

  it("retains exact full-data hash mismatch without valid credit", async () => {
    // Given: valid bytes are renamed under a different canonical checksum.
    const pair = writeEnvelopePair(storageDir),
      wrongKey = pair.baseKey.replace(/[0-9a-f]{16}$/, "0123456789abcdef")
    Fs.renameSync(pair.dataPath, Path.join(storageDir, `${wrongKey}.data`))
    Fs.renameSync(
      pair.metadataPath,
      Path.join(storageDir, `${wrongKey}.metadata`)
    )

    // When: strict validation recomputes the complete data digest.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    // Then: the issue contains both exact digest claims and zero valid credit.
    expect(result.valid).toEqual([])
    expect(result.issues).toEqual([
      {
        code: EnvelopeIntegrityIssueCode.DataHashMismatch,
        baseKey: wrongKey,
        context: {
          expectedHashPrefix: "0123456789abcdef",
          actualHashPrefix: pair.sha256.slice(0, 16),
          actualSha256: pair.sha256
        }
      }
    ])
  })

  it("retains exact metadata checksum mismatch without valid credit", async () => {
    // Given: a leading-zero pair receives a different numeric metadata checksum.
    const pair = writeLeadingZeroPair(storageDir)
    Fs.writeFileSync(
      pair.metadataPath,
      DebugEnvelopeMetadataRecord.toBinary(
        DebugEnvelopeMetadataRecord.create({
          checksum: 0x123n,
          batchOpNames: ["batchop.a"]
        })
      )
    )

    // When: strict validation compares padded metadata checksum text.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    // Then: expected and actual values remain exact with zero valid credit.
    expect(result.valid).toEqual([])
    expect(result.issues).toEqual([
      {
        code: EnvelopeIntegrityIssueCode.MetadataChecksumMismatch,
        baseKey: pair.baseKey,
        context: {
          expectedChecksum: pair.sha256.slice(0, 12),
          actualChecksum: "000000000123"
        }
      }
    ])
  })

  it("retains exact decoded epoch mismatch without valid credit", async () => {
    // Given: key epoch 42 contains an envelope decoded as epoch 43.
    const pair = writeEnvelopePair(storageDir, {
      keyEpoch: 42,
      decodedEpoch: 43
    })

    // When: strict validation compares key and decoded epochs.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    // Then: exact epochs and base key survive with zero valid credit.
    expect(result.valid).toEqual([])
    expect(result.issues).toEqual([
      {
        code: EnvelopeIntegrityIssueCode.EpochMismatch,
        baseKey: pair.baseKey,
        context: { keyEpoch: 42, decodedEpoch: 43 }
      }
    ])
  })

  it.each([
    ["varint", 0],
    ["fixed64", 1],
    ["length-delimited", 2],
    ["fixed32", 5]
  ])("rejects a top-level unknown %s data field", async (_label, wireType) => {
    // Given: a canonical envelope gains an unknown field with a valid wire value.
    const pair = writeEnvelopePair(storageDir),
      unknownField = encodedUnknownField(wireType),
      rewritten = rewriteDataPair(pair, Buffer.concat([pair.dataBytes, unknownField]))

    // When: strict validation decodes the hash-consistent pair.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    // Then: the unknown field is a data decode failure and earns no valid credit.
    expect(result.valid).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: EnvelopeIntegrityIssueCode.DataDecodeFailed,
        baseKey: rewritten.baseKey
      })
    ])
  })

  it("rejects an unknown field nested in a known message payload", async () => {
    // Given: a canonical envelope gains a known Message containing an unknown payload field.
    const pair = writeEnvelopePair(storageDir),
      payload = encodedUnknownField(0),
      message = Buffer.concat([
        Buffer.from([0x12]),
        encodeVarint(payload.byteLength),
        payload
      ]),
      nestedMessage = Buffer.concat([
        encodeVarint((40 << 3) | 2),
        encodeVarint(message.byteLength),
        message
      ]),
      rewritten = rewriteDataPair(
        pair,
        Buffer.concat([pair.dataBytes, nestedMessage])
      )

    // When: strict validation recursively decodes the known nested message.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    // Then: the nested unknown field is rejected before the pair receives credit.
    expect(result.valid).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: EnvelopeIntegrityIssueCode.DataDecodeFailed,
        baseKey: rewritten.baseKey,
        context: expect.objectContaining({
          reason: expect.stringContaining("sysio.opp.MessagePayload")
        })
      })
    ])
  })

  it("rejects an unknown metadata field", async () => {
    // Given: canonical metadata gains an unknown length-delimited field.
    const pair = writeEnvelopePair(storageDir)
    Fs.writeFileSync(
      pair.metadataPath,
      Buffer.concat([pair.metadataBytes, encodedUnknownField(2)])
    )

    // When: strict validation decodes the metadata sidecar.
    const result = await readEnvelopeIntegrity(
      storageDir,
      createEnvelopeBaseline([])
    )

    // Then: metadata decoding fails without changing the public issue category.
    expect(result.valid).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: EnvelopeIntegrityIssueCode.MetadataDecodeFailed,
        baseKey: pair.baseKey
      })
    ])
  })
})

type RewritableEnvelopePair = ReturnType<typeof writeEnvelopePair>

/** Base key of a pair republished under a freshly computed digest. */
interface RewrittenEnvelopePair {
  readonly baseKey: string
}

function rewriteDataPair(
  pair: RewritableEnvelopePair,
  dataBytes: Buffer
): RewrittenEnvelopePair {
  const sha256 = createHash("sha256").update(dataBytes).digest("hex"),
    baseKey = pair.baseKey.replace(/[0-9a-f]{16}$/, sha256.slice(0, 16)),
    dataPath = Path.join(Path.dirname(pair.dataPath), `${baseKey}.data`),
    metadataPath = Path.join(Path.dirname(pair.metadataPath), `${baseKey}.metadata`)
  Fs.rmSync(pair.dataPath)
  Fs.rmSync(pair.metadataPath)
  Fs.writeFileSync(dataPath, dataBytes)
  Fs.writeFileSync(
    metadataPath,
    DebugEnvelopeMetadataRecord.toBinary(
      DebugEnvelopeMetadataRecord.create({
        checksum: BigInt(`0x${sha256.slice(0, 12)}`),
        batchOpNames: ["batchop.a"]
      })
    )
  )
  return { baseKey }
}

function encodedUnknownField(wireType: number): Buffer {
  const tag = encodeVarint((500 << 3) | wireType)
  return match(wireType)
    .with(WireType.Varint, () => Buffer.concat([tag, Buffer.from([1])]))
    .with(WireType.Bit64, () => Buffer.concat([tag, Buffer.alloc(8)]))
    .with(WireType.LengthDelimited, () =>
      Buffer.concat([tag, Buffer.from([1, 1])])
    )
    .with(WireType.Bit32, () => Buffer.concat([tag, Buffer.alloc(4)]))
    .otherwise(() => {
      throw new Error(`unsupported test wire type ${wireType}`)
    })
}

