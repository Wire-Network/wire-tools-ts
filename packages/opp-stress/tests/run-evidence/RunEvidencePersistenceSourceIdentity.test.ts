import Fs from "node:fs"
import Path from "node:path"

import {
  allocateRunningPersistence,
  artifactCapture,
  createPersistenceWorkspace,
  type PersistenceWorkspace,
  writeOppPair
} from "./runEvidencePersistenceTestSupport.js"

type PairPaths = {
  readonly dataFile: string
  readonly metadataFile: string
}

type ReplacementCase = {
  readonly label: string
  readonly replace: (workspace: PersistenceWorkspace, paths: PairPaths) => void
}

const ReplacementCases: readonly ReplacementCase[] = [
  {
    label: "root symlink replacement",
    replace: (workspace, _paths) => {
      const displaced = Path.join(workspace.root, "displaced-root")
      Fs.renameSync(workspace.oppRoot, displaced)
      Fs.symlinkSync(displaced, workspace.oppRoot, "dir")
    }
  },
  {
    label: "parent directory replacement",
    replace: (workspace, paths) => {
      const dataDirectory = Path.dirname(workspace.oppRoot),
        displaced = Path.join(workspace.root, "displaced-data-directory")
      Fs.renameSync(dataDirectory, displaced)
      Fs.mkdirSync(workspace.oppRoot, { recursive: true })
      Fs.writeFileSync(paths.dataFile, Buffer.from("replacement"))
      Fs.writeFileSync(paths.metadataFile, Buffer.from([0xff]))
    }
  },
  {
    label: "regular data pathname replacement",
    replace: (_workspace, paths) => {
      Fs.renameSync(paths.dataFile, `${paths.dataFile}.validated`)
      Fs.writeFileSync(paths.dataFile, Buffer.from("replacement"))
    }
  },
  {
    label: "mixed pair pathname replacement",
    replace: (_workspace, paths) => {
      Fs.renameSync(paths.dataFile, `${paths.dataFile}.validated`)
      Fs.renameSync(paths.metadataFile, `${paths.metadataFile}.validated`)
      Fs.writeFileSync(paths.dataFile, Buffer.from("replacement"))
      Fs.writeFileSync(paths.metadataFile, Buffer.from([0xff]))
    }
  }
]

describe("RunEvidencePersistence snapshot source independence", () => {
  it.each(ReplacementCases)(
    "ignores $label after validation",
    async ({ replace }) => {
      // Given: exact valid bytes already accepted from the strict-reader generation.
      const workspace = createPersistenceWorkspace(),
        baseKey = writeOppPair(workspace.oppRoot, ["operator.a"]),
        request = artifactCapture(workspace.oppRoot, baseKey),
        expectedData = Buffer.from(request.dataBytes),
        expectedMetadata = Buffer.from(request.metadataBytes),
        paths: PairPaths = {
          dataFile: Path.join(workspace.oppRoot, `${baseKey}.data`),
          metadataFile: Path.join(workspace.oppRoot, `${baseKey}.metadata`)
        },
        persistence = await allocateRunningPersistence(workspace)
      try {
        // When: every source pathname changes before snapshot persistence.
        replace(workspace, paths)
        const refs = await persistence
          .beginObservation("103")
          .captureArtifact(request)
        // Then: no displaced or replacement generation becomes authoritative.
        expect(
          Fs.readFileSync(Path.join(persistence.runDirectory, refs.data.path))
        ).toEqual(expectedData)
        expect(
          Fs.readFileSync(
            Path.join(persistence.runDirectory, refs.metadata.path)
          )
        ).toEqual(expectedMetadata)
      } finally {
        workspace.cleanup()
      }
    }
  )
})
