import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityIssue
} from "@wireio/debugging-shared"
import { match } from "ts-pattern"

import {
  OppEnvelopeTelemetryIssueCode,
  type OppEnvelopeTelemetryIssue
} from "./TelemetryIssueTypes.js"

/**
 * Map one strict-reader issue to its lossless telemetry counterpart.
 *
 * @param issue Strict reader issue with code-correlated context.
 * @returns Telemetry issue preserving the serialized code, base key, and context.
 */
export function mapEnvelopeIntegrityIssue(
  issue: EnvelopeIntegrityIssue
): OppEnvelopeTelemetryIssue {
  return match<EnvelopeIntegrityIssue, OppEnvelopeTelemetryIssue>(issue)
    .with({ code: EnvelopeIntegrityIssueCode.InvalidStorageKey }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.InvalidStorageKey,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with({ code: EnvelopeIntegrityIssueCode.UnknownEndpoint }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.UnknownEndpoint,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with({ code: EnvelopeIntegrityIssueCode.MissingDataSidecar }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.MissingDataSidecar,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with(
      { code: EnvelopeIntegrityIssueCode.MissingMetadataSidecar },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with({ code: EnvelopeIntegrityIssueCode.DataSidecarSymlink }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.DataSidecarSymlink,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with(
      { code: EnvelopeIntegrityIssueCode.MetadataSidecarSymlink },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.MetadataSidecarSymlink,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with(
      { code: EnvelopeIntegrityIssueCode.DataSidecarNotRegular },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.DataSidecarNotRegular,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with(
      { code: EnvelopeIntegrityIssueCode.MetadataSidecarNotRegular },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.MetadataSidecarNotRegular,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with({ code: EnvelopeIntegrityIssueCode.DataReadFailed }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.DataReadFailed,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with({ code: EnvelopeIntegrityIssueCode.MetadataReadFailed }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.MetadataReadFailed,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with({ code: EnvelopeIntegrityIssueCode.DataSidecarChanged }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.DataSidecarChanged,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with(
      { code: EnvelopeIntegrityIssueCode.MetadataSidecarChanged },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.MetadataSidecarChanged,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with({ code: EnvelopeIntegrityIssueCode.DataDecodeFailed }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.DataDecodeFailed,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with(
      { code: EnvelopeIntegrityIssueCode.MetadataDecodeFailed },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.MetadataDecodeFailed,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with({ code: EnvelopeIntegrityIssueCode.DataHashMismatch }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.DataHashMismatch,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with(
      { code: EnvelopeIntegrityIssueCode.MetadataChecksumMismatch },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.MetadataChecksumMismatch,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with({ code: EnvelopeIntegrityIssueCode.EpochMismatch }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.EpochMismatch,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with(
      { code: EnvelopeIntegrityIssueCode.PathOutsideStorageRoot },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.PathOutsideStorageRoot,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with({ code: EnvelopeIntegrityIssueCode.StorageRootSymlink }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.StorageRootSymlink,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with(
      { code: EnvelopeIntegrityIssueCode.StorageAncestorSymlink },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.StorageAncestorSymlink,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with(
      { code: EnvelopeIntegrityIssueCode.StorageRootNotDirectory },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.StorageRootNotDirectory,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with({ code: EnvelopeIntegrityIssueCode.StorageRootChanged }, matched => ({
      code: OppEnvelopeTelemetryIssueCode.StorageRootChanged,
      baseKey: matched.baseKey,
      context: matched.context
    }))
    .with(
      { code: EnvelopeIntegrityIssueCode.StorageRootReadFailed },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.StorageRootReadFailed,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with(
      { code: EnvelopeIntegrityIssueCode.BaselineCaptureFailed },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .with(
      { code: EnvelopeIntegrityIssueCode.DirectoryScanFailed },
      matched => ({
        code: OppEnvelopeTelemetryIssueCode.DirectoryScanFailed,
        baseKey: matched.baseKey,
        context: matched.context
      })
    )
    .otherwise(value => assertNever(value))
}

function assertNever(value: never): never {
  throw new Error(`Unexpected envelope integrity issue: ${String(value)}`)
}
