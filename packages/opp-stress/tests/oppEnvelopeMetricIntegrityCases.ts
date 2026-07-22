import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppEnvelopeTelemetryIssueCode,
  type OppEnvelopeTelemetryIssue
} from "@wireio/test-opp-stress"

import {
  MetricEpoch,
  writeInvalidMetricPair,
  writeMetricEnvelopeFixture
} from "./oppEnvelopeMetricTestSupport.js"

/** One real-disk integrity mutation and its exact projected issue. */
export type MetricIntegrityCase = {
  readonly label: string
  readonly arrange: (storageDir: string) => OppEnvelopeTelemetryIssue
}

/** Exact candidate issues expected from strict metric projection. */
export const MetricIntegrityCases = [
  {
    label: "invalid key",
    arrange: storageDir => {
      const baseKey = "bad"
      writeInvalidMetricPair(storageDir, baseKey)
      return {
        code: OppEnvelopeTelemetryIssueCode.InvalidStorageKey,
        baseKey,
        context: { filename: baseKey, reason: "noncanonical_format" }
      }
    }
  },
  {
    label: "data decode",
    arrange: storageDir => {
      const pair = writeMetricEnvelopeFixture(storageDir, 0)
      Fs.writeFileSync(pair.dataPath, Buffer.from([0xff]))
      return {
        code: OppEnvelopeTelemetryIssueCode.DataDecodeFailed,
        baseKey: pair.baseKey,
        context: { path: pair.dataPath, reason: "premature EOF" }
      }
    }
  },
  {
    label: "metadata decode",
    arrange: storageDir => {
      const pair = writeMetricEnvelopeFixture(storageDir, 0)
      Fs.writeFileSync(pair.metadataPath, Buffer.from([0xff]))
      return {
        code: OppEnvelopeTelemetryIssueCode.MetadataDecodeFailed,
        baseKey: pair.baseKey,
        context: { path: pair.metadataPath, reason: "premature EOF" }
      }
    }
  },
  {
    label: "data hash",
    arrange: storageDir => {
      const pair = writeMetricEnvelopeFixture(storageDir, 0),
        wrongBaseKey = pair.baseKey.replace(
          /[0-9a-f]{16}$/,
          "0000000000000000"
        )
      Fs.renameSync(pair.dataPath, Path.join(storageDir, `${wrongBaseKey}.data`))
      Fs.renameSync(
        pair.metadataPath,
        Path.join(storageDir, `${wrongBaseKey}.metadata`)
      )
      return {
        code: OppEnvelopeTelemetryIssueCode.DataHashMismatch,
        baseKey: wrongBaseKey,
        context: {
          expectedHashPrefix: "0000000000000000",
          actualHashPrefix: pair.sha256.slice(0, 16),
          actualSha256: pair.sha256
        }
      }
    }
  },
  {
    label: "metadata checksum",
    arrange: storageDir => {
      const pair = writeMetricEnvelopeFixture(storageDir, 0, {
        metadataChecksum: 1n
      })
      return {
        code: OppEnvelopeTelemetryIssueCode.MetadataChecksumMismatch,
        baseKey: pair.baseKey,
        context: {
          expectedChecksum: pair.sha256.slice(0, 12),
          actualChecksum: "000000000001"
        }
      }
    }
  },
  {
    label: "decoded epoch",
    arrange: storageDir => {
      const pair = writeMetricEnvelopeFixture(storageDir, 0, {
        keyEpoch: MetricEpoch,
        decodedEpoch: MetricEpoch + 1
      })
      return {
        code: OppEnvelopeTelemetryIssueCode.EpochMismatch,
        baseKey: pair.baseKey,
        context: { keyEpoch: MetricEpoch, decodedEpoch: MetricEpoch + 1 }
      }
    }
  }
] satisfies readonly MetricIntegrityCase[]
