import { EnvelopeIntegrityValidationConcurrency } from "./EnvelopeIntegrityReaderTypes.js"
import type { EnvelopeCandidateValidationResult } from "./envelopeIntegrityValidationTypes.js"

/**
 * Validate candidates through the fixed strict-reader worker bound.
 *
 * @param candidates Deterministically scanned post-baseline keys.
 * @param validate One-candidate strict validation operation.
 * @returns Every validation outcome for deterministic caller-side sorting.
 */
export async function validateWithWorkerPool(
  candidates: readonly string[],
  validate: (baseKey: string) => Promise<EnvelopeCandidateValidationResult>
): Promise<readonly EnvelopeCandidateValidationResult[]> {
  const results: EnvelopeCandidateValidationResult[] = []
  let nextIndex = 0
  const runWorker = async (): Promise<void> => {
    const index = nextIndex
    nextIndex += 1
    const baseKey = candidates.at(index)
    if (baseKey === undefined) return
    results.push(await validate(baseKey))
    await runWorker()
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          EnvelopeIntegrityValidationConcurrency,
          candidates.length
        )
      },
      () => runWorker()
    )
  )
  return results
}
