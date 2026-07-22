import { randomUUID } from "node:crypto"
import Fs from "node:fs"
import Path from "node:path"

import { AtomicFile } from "./AtomicFile.js"
import {
  AtomicFileOperationError,
  atomicFileErrorCode,
  removeAtomicTemp,
  syncAtomicParent,
  writeAtomicTemp,
  type AtomicFileContext
} from "./atomicFileOperations.js"

const DefaultMode = 0o600,
  MissingErrorCode = "ENOENT",
  NodeFileSystem = {
    lstat: Fs.promises.lstat,
    open: Fs.promises.open,
    link: Fs.promises.link,
    rename: Fs.promises.rename,
    unlink: Fs.promises.unlink
  } satisfies AtomicFile.FileSystem

type PublishOptions = {
  readonly request: AtomicFile.PublishRequest
  readonly dependencies: AtomicFile.Dependencies
  readonly createOnly: boolean
}

type FailureState = {
  readonly operation: AtomicFileOperationError
  readonly committed: boolean
  readonly residualTempFile: string | null
}

/**
 * Execute one create-or-replace publication for the public API.
 * @param options Typed request, dependencies, and commit mode.
 * @return Committed publication result.
 */
export async function publishAtomicFile(
  options: PublishOptions
): Promise<AtomicFile.PublishResult> {
  const { request, dependencies, createOnly } = options,
    fileSystem = { ...NodeFileSystem, ...dependencies.fileSystem },
    tempFile = Path.join(
      Path.dirname(request.finalFile),
      `.${Path.basename(request.finalFile)}.${(dependencies.tempToken ?? randomUUID)()}.tmp`
    ),
    context: AtomicFileContext = {
      finalFile: request.finalFile,
      tempFile,
      fileSystem
    }

  await rejectSymlinkedPath(context)
  try {
    await writeAtomicTemp(context, request.data, request.mode ?? DefaultMode)
  } catch (error) {
    throw await beforeCommitError(context, error)
  }

  try {
    if (createOnly) await fileSystem.link(tempFile, request.finalFile)
    else await fileSystem.rename(tempFile, request.finalFile)
  } catch (error) {
    const stage = createOnly ? AtomicFile.Stage.Link : AtomicFile.Stage.Rename
    throw await beforeCommitError(
      context,
      new AtomicFileOperationError(stage, error)
    )
  }

  let postCommitError: AtomicFileOperationError | null = null,
    residualTempFile: string | null = null
  if (createOnly) {
    try {
      await fileSystem.unlink(tempFile)
    } catch (error) {
      if (atomicFileErrorCode(error) !== MissingErrorCode) {
        postCommitError = new AtomicFileOperationError(
          AtomicFile.Stage.TempUnlink,
          error
        )
        residualTempFile = tempFile
      }
    }
  }
  try {
    await syncAtomicParent(context)
  } catch (error) {
    if (!(error instanceof AtomicFileOperationError)) throw error
    postCommitError = postCommitError
      ? postCommitError.withOperation(error)
      : error
  }
  if (postCommitError) {
    throw publishError(context, {
      operation: postCommitError,
      committed: true,
      residualTempFile
    })
  }
  return { committed: true, finalFile: request.finalFile }
}

async function rejectSymlinkedPath(context: AtomicFileContext): Promise<void> {
  const resolved = Path.resolve(context.finalFile),
    root = Path.parse(resolved).root,
    components = resolved.slice(root.length).split(Path.sep).filter(Boolean)
  try {
    await components.reduce(async (parentPromise, component) => {
      const parent = await parentPromise,
        candidate = Path.join(parent, component)
      try {
        if ((await context.fileSystem.lstat(candidate)).isSymbolicLink()) {
          throw new TypeError(`symbolic-link path rejected: ${candidate}`)
        }
      } catch (error) {
        if (atomicFileErrorCode(error) !== MissingErrorCode) throw error
      }
      return candidate
    }, Promise.resolve(root))
  } catch (error) {
    throw new AtomicFile.PublishError({
      stage: AtomicFile.Stage.Validate,
      finalFile: context.finalFile,
      committed: false,
      residualTempFile: null,
      cause: error
    })
  }
}

async function beforeCommitError(
  context: AtomicFileContext,
  error: unknown
): Promise<AtomicFile.PublishError> {
  const cleanupError = await removeAtomicTemp(context)
  let operation =
    error instanceof AtomicFileOperationError
      ? error
      : new AtomicFileOperationError(AtomicFile.Stage.TempOpen, error)
  if (cleanupError) {
    operation = operation.withSecondary(
      AtomicFile.Stage.TempUnlink,
      cleanupError
    )
  }
  return publishError(context, {
    operation,
    committed: false,
    residualTempFile: cleanupError ? context.tempFile : null
  })
}

function publishError(
  context: AtomicFileContext,
  state: FailureState
): AtomicFile.PublishError {
  return new AtomicFile.PublishError({
    stage: state.operation.stage,
    finalFile: context.finalFile,
    committed: state.committed,
    residualTempFile: state.residualTempFile,
    cause: state.operation.original,
    secondaryFailures: state.operation.secondaryFailures
  })
}
