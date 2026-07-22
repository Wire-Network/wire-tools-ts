import Fs from "node:fs"
import Path from "node:path"

import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./RunEvidencePersistenceError.js"
import {
  changedSource,
  pinCanonicalChildFile,
  pinCanonicalDirectory,
  revalidateCanonicalChildFile,
  revalidateCanonicalDirectory,
  sameNodeIdentity,
  sameStableFileIdentity,
  unsafeSource
} from "./sourcePathIdentity.js"
import type { CanonicalDirectorySnapshot } from "./sourcePathIdentity.js"

const DirectoryMode = 0o700

/** Node filesystem implementation used by safe source reads and run allocation. */
export const NodeSourceFileSystem: RunEvidencePersistence.SourceFileSystem = {
  lstat: Fs.promises.lstat,
  realpath: Fs.promises.realpath,
  open: (file, flags) => Fs.promises.open(file, flags),
  mkdir: async (directory, options) => {
    await Fs.promises.mkdir(directory, options)
  }
}

/** Canonical cluster identity and fixed external run directory. */
export type RunDirectoryAllocation = {
  readonly clusterPath: string
  readonly runDirectory: string
  readonly revalidateClusterPath: () => Promise<void>
}

type IntendedClusterPath = {
  readonly path: string
  readonly stat: RunEvidencePersistence.SourceStat | null
  readonly ancestors: CanonicalDirectorySnapshot
}

/** Create the fixed sibling evidence layout for one canonical cluster. */
export async function prepareRunDirectory(
  clusterPath: string,
  runId: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<RunDirectoryAllocation> {
  const cluster = await pinIntendedClusterPath(clusterPath, fileSystem),
    evidenceRoot = `${cluster.path}-swap-stress-evidence`,
    revalidateClusterPath = () =>
      revalidateIntendedClusterPath(cluster, fileSystem)
  await createDirectoryIfMissing(evidenceRoot, fileSystem)
  const evidence = await pinCanonicalDirectory(evidenceRoot, fileSystem)
  await revalidateClusterPath()
  if (
    (cluster.stat !== null && sameNodeIdentity(cluster.stat, evidence.stat)) ||
    isEqualOrContained(cluster.path, evidence.path) ||
    isEqualOrContained(evidence.path, cluster.path)
  )
    throw unsafeSource(
      `evidence root must be a distinct sibling of the cluster: ${evidence.path}`
    )
  const runsDirectory = Path.join(evidence.path, "runs")
  await createDirectoryIfMissing(runsDirectory, fileSystem)
  await pinCanonicalDirectory(runsDirectory, fileSystem)
  const runDirectory = Path.join(runsDirectory, runId)
  try {
    await fileSystem.mkdir(runDirectory, { mode: DirectoryMode })
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error
    throw new RunEvidencePersistenceError(
      RunEvidencePersistenceErrorCode.InvalidState,
      `run evidence destination already exists: ${runDirectory}`,
      { cause: error }
    )
  }
  await Promise.all([
    fileSystem.mkdir(Path.join(runDirectory, "iterations"), {
      mode: DirectoryMode
    }),
    fileSystem.mkdir(Path.join(runDirectory, "artifacts", "opp"), {
      recursive: true,
      mode: DirectoryMode
    })
  ])
  await pinCanonicalDirectory(runDirectory, fileSystem)
  await revalidateClusterPath()
  return { clusterPath: cluster.path, runDirectory, revalidateClusterPath }
}

/** Read a fixed child file through a stable, no-symlink, contained handle. */
export async function readStableSourceFile(
  sourceRoot: string,
  filename: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<Buffer> {
  const root = await pinCanonicalDirectory(sourceRoot, fileSystem),
    source = await pinCanonicalChildFile(root, filename, fileSystem)
  const handle = await fileSystem.open(
    source.path,
    Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW
  )
  try {
    const before = await handle.stat()
    if (!sameStableFileIdentity(source.stat, before) || !before.isFile())
      throw changedSource(`source identity changed before read: ${source.path}`)
    const bytes = await handle.readFile(),
      after = await handle.stat()
    if (!sameStableFileIdentity(before, after))
      throw changedSource(`source changed while being read: ${source.path}`)
    await Promise.all([
      revalidateCanonicalDirectory(root, fileSystem),
      revalidateCanonicalChildFile(source, fileSystem)
    ])
    return bytes
  } finally {
    await handle.close()
  }
}

async function createDirectoryIfMissing(
  directory: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<void> {
  try {
    await fileSystem.lstat(directory)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    await fileSystem.mkdir(directory, { mode: DirectoryMode })
  }
}

async function pinIntendedClusterPath(
  clusterPath: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<IntendedClusterPath> {
  const path = Path.resolve(clusterPath),
    parent = await pinCanonicalDirectory(Path.dirname(path), fileSystem)
  let stat: RunEvidencePersistence.SourceStat
  try {
    stat = await fileSystem.lstat(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return { path, stat: null, ancestors: parent }
    throw unsafeSource(`cluster path cannot be inspected: ${path}`, error)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw unsafeSource(`cluster path is unsafe: ${path}`)
  const directory = await pinCanonicalDirectory(path, fileSystem)
  return { path, stat: directory.stat, ancestors: directory }
}

async function revalidateIntendedClusterPath(
  cluster: IntendedClusterPath,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<void> {
  await revalidateCanonicalDirectory(cluster.ancestors, fileSystem)
  if (cluster.stat !== null) return
  try {
    await fileSystem.lstat(cluster.path)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw changedSource(
      `initially absent cluster path cannot be inspected: ${cluster.path}`,
      error
    )
  }
  throw changedSource(
    `initially absent cluster path acquired an identity: ${cluster.path}`
  )
}

function isEqualOrContained(parent: string, candidate: string): boolean {
  const relative = Path.relative(parent, candidate)
  return (
    relative.length === 0 ||
    (!relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  )
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : null
}
