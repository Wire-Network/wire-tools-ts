import Fs from "node:fs"
import Path from "node:path"

import { RunEvidencePath } from "@wireio/test-opp-stress"

import {
  allocateRunningPersistence,
  artifactCapture,
  createPersistenceWorkspace,
  readJson,
  writeOppPair,
  type PersistenceWorkspace
} from "./runEvidencePersistenceTestSupport.js"

type CandidateSource = {
  readonly sourceRoot: string
  readonly baseKey: string
}

type SourceCase = {
  readonly label: string
  readonly arrange: (workspace: PersistenceWorkspace) => CandidateSource
}

const SourceCases: readonly SourceCase[] = [
  {
    label: "cluster parent",
    arrange: workspace => ({
      sourceRoot: workspace.root,
      baseKey: writeOppPair(workspace.root, ["operator.a"])
    })
  },
  {
    label: "evidence root",
    arrange: workspace => ({
      sourceRoot: workspace.evidenceRoot,
      baseKey: writeOppPair(workspace.evidenceRoot, ["operator.a"])
    })
  },
  {
    label: "symlink alias",
    arrange: workspace => {
      const target = Path.join(workspace.root, "source-target"),
        sourceRoot = Path.join(workspace.root, "source-alias"),
        baseKey = writeOppPair(target, ["operator.a"])
      Fs.symlinkSync(target, sourceRoot, "dir")
      return { sourceRoot, baseKey }
    }
  }
]

describe("RunEvidencePersistence canonical source root", () => {
  it.each(SourceCases)(
    "ignores mutable bytes from the $label",
    async ({ arrange }) => {
      // Given: exact canonical bytes and different valid metadata at another path.
      const workspace = createPersistenceWorkspace()
      try {
        const persistence = await allocateRunningPersistence(workspace),
          canonicalBaseKey = writeOppPair(workspace.oppRoot, [
            "operator.canonical"
          ]),
          request = artifactCapture(workspace.oppRoot, canonicalBaseKey),
          candidate = arrange(workspace),
          runtimeRequest = { ...request, sourceRoot: candidate.sourceRoot }
        expect(candidate.baseKey).toBe(canonicalBaseKey)
        // When: an untyped runtime caller also supplies an attacker-selected path.
        const refs = await persistence
          .beginObservation("103")
          .captureArtifact(runtimeRequest)
        // Then: only supplied exact bytes determine immutable evidence.
        expect(
          Fs.readFileSync(
            Path.join(persistence.runDirectory, refs.metadata.path)
          )
        ).toEqual(request.metadataBytes)
        expect(
          readJson(
            Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
          )
        ).toMatchObject({
          artifacts: [{ lastAcceptedBatchOpNames: ["operator.canonical"] }]
        })
      } finally {
        workspace.cleanup()
      }
    }
  )
})
