import {
  RunEvidenceParseResultKind,
  RunEvidencePath,
  parseRunEvidenceArtifact,
  parseRunEvidenceProvenance
} from "@wireio/test-opp-stress"

import {
  artifactEntry,
  EvidenceBaseKey,
  provenance
} from "./runEvidenceSchemaFixtures.js"

describe("schema-v1 artifact and provenance paths", () => {
  it.each([
    ["canonical artifact", parseRunEvidenceArtifact, artifactEntry],
    ["absolute provenance", parseRunEvidenceProvenance, provenance]
  ])("accepts %s", (_label, parser, fixture) => {
    // Given: a canonical clean-v1 path fixture.
    // When: the matching unknown-boundary parser runs.
    const result = parser(fixture)
    // Then: the canonical value is preserved.
    expect(result).toEqual({ ok: true, value: fixture })
  })

  it.each([
    [
      "Windows traversal base key",
      artifactWithBaseKey("..\\..\\..\\outside-run")
    ],
    ["POSIX traversal base key", artifactWithBaseKey("../../../outside-run")],
    [
      "noncanonical base key",
      artifactWithBaseKey("87654321-UNKNOWN-fedcba9876543210")
    ],
    [
      "bad epoch padding",
      artifactWithBaseKey("1-DEPOT_OUTPOST_SOLANA-fedcba9876543210")
    ],
    [
      "bad checksum",
      artifactWithBaseKey("87654321-DEPOT_OUTPOST_SOLANA-FEDCBA9876543210")
    ],
    [
      "absolute data ref",
      {
        ...artifactEntry,
        firstImmutableRefs: {
          ...artifactEntry.firstImmutableRefs,
          data: {
            ...artifactEntry.firstImmutableRefs.data,
            path: `/tmp/${EvidenceBaseKey}.data`
          }
        }
      }
    ],
    [
      "backslash artifact directory",
      {
        ...artifactEntry,
        firstImmutableRefs: {
          ...artifactEntry.firstImmutableRefs,
          data: {
            ...artifactEntry.firstImmutableRefs.data,
            path: `artifacts\\opp\\${EvidenceBaseKey}.data`
          }
        }
      }
    ],
    [
      "unsorted duplicate operators",
      {
        ...artifactEntry,
        lastAcceptedBatchOpNames: [
          "operator.zeta",
          "operator.alpha",
          "operator.alpha"
        ]
      }
    ],
    ["relative provenance", { ...provenance, ethereumPath: "../ethereum" }],
    [
      "non-normalized provenance",
      { ...provenance, wireBuildPath: "/srv/wire/../wire/build" }
    ]
  ])("rejects %s", (_label, fixture) => {
    // Given: an adversarial path or noncanonical storage-key mutation.
    const parser = Object.hasOwn(fixture, "baseKey")
      ? parseRunEvidenceArtifact
      : parseRunEvidenceProvenance
    // When: the matching parser receives the mutation.
    const result = parser(fixture)
    // Then: platform-independent validation rejects it.
    expect(result).toMatchObject({
      ok: false,
      error: { kind: RunEvidenceParseResultKind.Failure }
    })
  })
})

function artifactWithBaseKey(
  baseKey: string
): Readonly<Record<string, unknown>> {
  return {
    ...artifactEntry,
    baseKey,
    firstImmutableRefs: {
      data: {
        ...artifactEntry.firstImmutableRefs.data,
        path: `${RunEvidencePath.Artifacts}/${baseKey}.data`
      },
      metadata: {
        ...artifactEntry.firstImmutableRefs.metadata,
        path: `${RunEvidencePath.Artifacts}/${baseKey}.metadata`
      }
    }
  }
}
