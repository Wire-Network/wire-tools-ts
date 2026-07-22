import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  parseRunEvidenceManifest,
  RunEvidenceClusterConfigState,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidencePersistence,
  RunEvidencePersistenceErrorCode
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocationOptions,
  readJson,
  TestEndpoint,
  TestRunId
} from "./runEvidencePersistenceTestSupport.js"
import type { PersistenceWorkspace } from "./runEvidencePersistenceTestSupport.js"

type StaleFinalComponentCase = {
  readonly label: string
  readonly followsAlias: boolean
  readonly install: (workspace: PersistenceWorkspace) => void
}

const StaleFinalComponentCases: readonly StaleFinalComponentCase[] = [
  {
    label: "symlink",
    followsAlias: false,
    install: workspace => {
      const target = Path.join(workspace.root, "symlink-target")
      Fs.writeFileSync(target, "target")
      Fs.symlinkSync(target, workspace.clusterPath)
    }
  },
  {
    label: "regular file",
    followsAlias: false,
    install: workspace => Fs.writeFileSync(workspace.clusterPath, "file")
  },
  {
    label: "directory",
    followsAlias: false,
    install: workspace => Fs.mkdirSync(workspace.clusterPath)
  },
  {
    label: "realpath alias",
    followsAlias: true,
    install: workspace => {
      const target = Path.join(workspace.root, "alias-target")
      Fs.mkdirSync(target)
      Fs.symlinkSync(target, workspace.clusterPath)
    }
  }
]

describe("RunEvidencePersistence pre-cluster allocation", () => {
  it("allocates the fixed sibling run before the intended cluster exists", async () => {
    // Given: only the canonical parent of the intended cluster exists.
    const workspace = createPreClusterWorkspace()
    try {
      // When: Todo 23 allocates evidence before fresh cluster setup.
      const persistence = await RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies()
        ),
        manifest = readJson(
          Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
        )
      // Then: the initializing manifest is valid at the exact sibling root.
      expect(persistence.runDirectory).toBe(
        Path.join(workspace.evidenceRoot, "runs", TestRunId)
      )
      expect(parseRunEvidenceManifest(manifest).ok).toBe(true)
      expect(manifest).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Initializing,
        clusterPath: Path.resolve(workspace.clusterPath),
        clusterConfigSnapshot: { kind: RunEvidenceClusterConfigState.Pending }
      })
      expect(Fs.existsSync(workspace.clusterPath)).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects an existing non-directory cluster path", async () => {
    // Given: the intended cluster path is occupied by a regular file.
    const workspace = createPreClusterWorkspace()
    Fs.writeFileSync(workspace.clusterPath, "not-a-directory")
    try {
      // When/Then: allocation preserves the existing-path safety contract.
      await expect(
        RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies()
        )
      ).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.UnsafeSource
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects an absent cluster beneath a symlinked ancestor", async () => {
    // Given: an existing ancestor aliases another canonical directory.
    const workspace = createPreClusterWorkspace(),
      realParent = Path.join(workspace.root, "real-parent"),
      aliasParent = Path.join(workspace.root, "alias-parent")
    Fs.mkdirSync(realParent)
    Fs.symlinkSync(realParent, aliasParent)
    try {
      // When/Then: an absent final component cannot bypass ancestor pinning.
      await expect(
        RunEvidencePersistence.allocate(
          {
            ...allocationOptions(workspace),
            clusterPath: Path.join(aliasParent, "cluster")
          },
          allocationDependencies()
        )
      ).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.UnsafeSource
      })
    } finally {
      workspace.cleanup()
    }
  })

  it.each(StaleFinalComponentCases)(
    "rejects a $label installed after the initial ENOENT",
    async attack => {
      // Given: the first cluster lstat installs an identity but returns its ENOENT.
      const workspace = createPreClusterWorkspace(),
        manifestFile = expectedManifestFile(workspace)
      let installed = false
      try {
        // When: allocation continues from the now-stale absence observation.
        await expect(
          RunEvidencePersistence.allocate(
            allocationOptions(workspace),
            allocationDependencies({
              lstat: async file => {
                if (file !== workspace.clusterPath)
                  return Fs.promises.lstat(file)
                if (installed)
                  return attack.followsAlias
                    ? Fs.promises.stat(file)
                    : Fs.promises.lstat(file)
                try {
                  return await Fs.promises.lstat(file)
                } catch (error) {
                  attack.install(workspace)
                  installed = true
                  throw error
                }
              }
            })
          )
        ).rejects.toMatchObject({
          name: "RunEvidencePersistenceError",
          code: RunEvidencePersistenceErrorCode.SourceChanged
        })
        // Then: no initializing manifest accepts the new final component.
        expect(Fs.existsSync(manifestFile)).toBe(false)
      } finally {
        workspace.cleanup()
      }
    }
  )

  it("rejects an inspection failure while revalidating absence", async () => {
    // Given: initial ENOENT is followed by an unreadable final component.
    const workspace = createPreClusterWorkspace(),
      manifestFile = expectedManifestFile(workspace)
    let clusterInspections = 0
    try {
      // When: the retained absence snapshot is revalidated after preparation.
      await expect(
        RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies({
            lstat: file => {
              if (file !== workspace.clusterPath) return Fs.promises.lstat(file)
              clusterInspections += 1
              if (clusterInspections === 1) return Fs.promises.lstat(file)
              return Promise.reject(
                Object.assign(new Error("inspection denied"), {
                  code: "EACCES"
                })
              )
            }
          })
        )
      ).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.SourceChanged
      })
      // Then: an indeterminate pathname cannot acquire a manifest.
      expect(Fs.existsSync(manifestFile)).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })

  it("revalidates after manifest assembly immediately before publication", async () => {
    // Given: preparation observes an absent cluster before manifest input is read.
    const workspace = createPreClusterWorkspace(),
      options = allocationOptions(workspace),
      manifestFile = expectedManifestFile(workspace)
    let installed = false
    Object.defineProperty(options, "requiredEndpoints", {
      get: () => {
        if (!installed) {
          Fs.mkdirSync(workspace.clusterPath)
          installed = true
        }
        return [TestEndpoint]
      }
    })
    try {
      // When: manifest assembly installs the cluster after preparation returns.
      await expect(
        RunEvidencePersistence.allocate(options, allocationDependencies())
      ).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.SourceChanged
      })
      // Then: the adjacent publication check prevents manifest commitment.
      expect(installed).toBe(true)
      expect(Fs.existsSync(manifestFile)).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })
})

function createPreClusterWorkspace(): PersistenceWorkspace {
  const root = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "run-evidence-precluster-")
    ),
    clusterPath = Path.join(root, "cluster")
  return {
    root,
    evidenceRoot: `${clusterPath}-swap-stress-evidence`,
    clusterPath,
    oppRoot: Path.join(clusterPath, "data", "opp-debugging"),
    configBytes: Buffer.from("unused"),
    cleanup: () => Fs.rmSync(root, { recursive: true, force: true })
  }
}

function expectedManifestFile(workspace: PersistenceWorkspace): string {
  return Path.join(
    workspace.evidenceRoot,
    "runs",
    TestRunId,
    RunEvidencePath.Manifest
  )
}
