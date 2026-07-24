import { AtomicFile } from "@wireio/debugging-shared"

/** Public publishers keyed by the operation name used in parameterized tests. */
export const AtomicFilePublishers = {
  create: AtomicFile.create,
  replace: AtomicFile.replace
}

/** Operation names accepted by {@link AtomicFilePublishers}. */
export type AtomicFilePublishMode = keyof typeof AtomicFilePublishers

/**
 * Create an errno-shaped failure for deterministic filesystem injection.
 * @param code Stable error code asserted by the test.
 * @return Error carrying the supplied code.
 */
export function atomicFileErrno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

/**
 * Capture and narrow an expected atomic publication rejection.
 * @param action Publication expected to reject.
 * @return Typed publication error.
 */
export async function captureAtomicFileError(
  action: () => Promise<AtomicFile.PublishResult>
): Promise<AtomicFile.PublishError> {
  return action().then(
    () => {
      throw new TypeError("expected AtomicFile.PublishError")
    },
    (error: unknown) => {
      if (!(error instanceof AtomicFile.PublishError)) throw error
      return error
    }
  )
}
