import Path from "node:path"

import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./RunEvidencePersistenceError.js"

type PathIdentity = {
  readonly path: string
  readonly stat: RunEvidencePersistence.SourceStat
}

/** Canonical directory path plus every retained component identity. */
export type CanonicalDirectorySnapshot = {
  readonly path: string
  readonly stat: RunEvidencePersistence.SourceStat
  readonly components: readonly PathIdentity[]
}

/** Canonical regular-file pathname identity retained across descriptor reads. */
export type CanonicalFileSnapshot = {
  readonly path: string
  readonly realPath: string
  readonly stat: RunEvidencePersistence.SourceStat
}

/** Pin a canonical directory and every existing component leading to it. */
export async function pinCanonicalDirectory(
  directory: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<CanonicalDirectorySnapshot> {
  const resolved = Path.resolve(directory),
    componentPaths = directoryComponentPaths(resolved),
    components = await Promise.all(
      componentPaths.map(async path => {
        const stat = await initialLstat(path, fileSystem)
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw unsafeSource(`source directory component is unsafe: ${path}`)
        return { path, stat }
      })
    ),
    realPath = await initialRealpath(resolved, fileSystem)
  if (realPath !== resolved)
    throw unsafeSource(`source root is not canonical: ${resolved}`)
  const stat = components.at(-1)?.stat
  if (stat === undefined)
    throw unsafeSource(`source root has no canonical identity: ${resolved}`)
  return { path: resolved, stat, components }
}

/** Revalidate every retained directory component and its canonical realpath. */
export async function revalidateCanonicalDirectory(
  snapshot: CanonicalDirectorySnapshot,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<void> {
  await Promise.all(
    snapshot.components.map(async component => {
      const current = await currentLstat(component.path, fileSystem)
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        !sameNodeIdentity(component.stat, current)
      )
        throw changedSource(
          `source directory identity changed: ${component.path}`
        )
    })
  )
  const realPath = await currentRealpath(snapshot.path, fileSystem)
  if (realPath !== snapshot.path)
    throw changedSource(`source root realpath changed: ${snapshot.path}`)
}

/** Pin one exact regular child file under a retained canonical directory. */
export async function pinCanonicalChildFile(
  root: CanonicalDirectorySnapshot,
  filename: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<CanonicalFileSnapshot> {
  if (Path.basename(filename) !== filename || filename.includes("\\"))
    throw unsafeSource(`unsafe source filename: ${filename}`)
  const path = Path.join(root.path, filename),
    stat = await initialLstat(path, fileSystem)
  if (stat.isSymbolicLink() || !stat.isFile())
    throw unsafeSource(`source is not a regular file: ${path}`)
  const realPath = await initialRealpath(path, fileSystem)
  if (realPath !== path)
    throw unsafeSource(`source escapes its canonical root: ${path}`)
  return { path, realPath, stat }
}

/** Revalidate one retained file pathname against its original full identity. */
export async function revalidateCanonicalChildFile(
  snapshot: CanonicalFileSnapshot,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<void> {
  const current = await currentLstat(snapshot.path, fileSystem)
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameStableFileIdentity(snapshot.stat, current)
  )
    throw changedSource(`source pathname identity changed: ${snapshot.path}`)
  const realPath = await currentRealpath(snapshot.path, fileSystem)
  if (realPath !== snapshot.realPath)
    throw changedSource(`source pathname realpath changed: ${snapshot.path}`)
}

/** Compare physical node identity without mutable directory timestamps. */
export function sameNodeIdentity(
  first: RunEvidencePersistence.SourceStat,
  second: RunEvidencePersistence.SourceStat
): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

/** Compare regular-file identity and every field used for read stability. */
export function sameStableFileIdentity(
  first: RunEvidencePersistence.SourceStat,
  second: RunEvidencePersistence.SourceStat
): boolean {
  return (
    sameNodeIdentity(first, second) &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  )
}

/** Construct a typed initial-path safety rejection. */
export function unsafeSource(
  message: string,
  cause?: unknown
): RunEvidencePersistenceError {
  return new RunEvidencePersistenceError(
    RunEvidencePersistenceErrorCode.UnsafeSource,
    message,
    { cause }
  )
}

/** Construct a typed post-pin source replacement rejection. */
export function changedSource(
  message: string,
  cause?: unknown
): RunEvidencePersistenceError {
  return new RunEvidencePersistenceError(
    RunEvidencePersistenceErrorCode.SourceChanged,
    message,
    { cause }
  )
}

function directoryComponentPaths(directory: string): readonly string[] {
  const root = Path.parse(directory).root,
    components = directory.slice(root.length).split(Path.sep).filter(Boolean)
  return components.reduce<readonly string[]>(
    (paths, component) => [
      ...paths,
      Path.join(paths.at(-1) ?? root, component)
    ],
    []
  )
}

async function initialLstat(
  path: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<RunEvidencePersistence.SourceStat> {
  try {
    return await fileSystem.lstat(path)
  } catch (error) {
    throw unsafeSource(`source path does not exist: ${path}`, error)
  }
}

async function initialRealpath(
  path: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<string> {
  try {
    return await fileSystem.realpath(path)
  } catch (error) {
    throw unsafeSource(`source path cannot be resolved: ${path}`, error)
  }
}

async function currentLstat(
  path: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<RunEvidencePersistence.SourceStat> {
  try {
    return await fileSystem.lstat(path)
  } catch (error) {
    throw changedSource(`source path disappeared: ${path}`, error)
  }
}

async function currentRealpath(
  path: string,
  fileSystem: RunEvidencePersistence.SourceFileSystem
): Promise<string> {
  try {
    return await fileSystem.realpath(path)
  } catch (error) {
    throw changedSource(`source path cannot be re-resolved: ${path}`, error)
  }
}
