import {
  runBoundedWorkload,
  type BoundedWorkloadResult
} from "./boundedWorkload.js"

/** One request paired with its position in the WHOLE burst, not its chunk. */
interface BurstWorkloadItem<Request> {
  readonly workloadIndex: number
  readonly request: Request
}

/** Requests, per-chunk concurrency, and the indexed submitter. */
interface ChunkedBoundedWorkloadOptions<Request, Result> {
  readonly requests: readonly Request[]
  readonly concurrency: number
  readonly submit: (request: Request, index: number) => Promise<Result>
}

/**
 * Run bounded workload chunks sequentially while preserving whole-burst indexes.
 *
 * @param options Requests, per-chunk concurrency, and indexed submitter.
 * @returns Success and failure telemetry keyed to original request positions.
 */
export async function runChunkedBoundedWorkload<Request, Result>(
  options: ChunkedBoundedWorkloadOptions<Request, Result>
): Promise<BoundedWorkloadResult<Result>> {
  assertPositiveInteger(options.concurrency, "burst concurrency")
  const chunks = chunk(
    options.requests.map((request, workloadIndex) => ({
      workloadIndex,
      request
    })),
    options.concurrency
  )
  return chunks.reduce<Promise<BoundedWorkloadResult<Result>>>(
    async (prior, nextChunk) =>
      mergeChunkResults(
        await prior,
        await runBoundedWorkload({
          requests: nextChunk,
          concurrency: options.concurrency,
          submit: item => options.submit(item.request, item.workloadIndex)
        }),
        nextChunk
      ),
    Promise.resolve({ successes: [], failures: [] })
  )
}

function mergeChunkResults<Request, Result>(
  prior: BoundedWorkloadResult<Result>,
  next: BoundedWorkloadResult<Result>,
  chunkItems: readonly BurstWorkloadItem<Request>[]
): BoundedWorkloadResult<Result> {
  return {
    successes: [
      ...prior.successes,
      ...next.successes.map(success => ({
        index: chunkWorkloadIndex(chunkItems, success.index),
        id: success.id
      }))
    ],
    failures: [
      ...prior.failures,
      ...next.failures.map(failure => ({
        index: chunkWorkloadIndex(chunkItems, failure.index),
        reason: failure.reason
      }))
    ]
  }
}

function chunk<Item>(items: readonly Item[], size: number): readonly Item[][] {
  return items.length === 0
    ? []
    : [items.slice(0, size), ...chunk(items.slice(size), size)]
}

function chunkWorkloadIndex<Request>(
  chunkItems: readonly BurstWorkloadItem<Request>[],
  chunkIndex: number
): number {
  const item = chunkItems[chunkIndex]
  if (item === undefined) {
    throw new RangeError(`missing chunk item for workload index ${chunkIndex}`)
  }
  return item.workloadIndex
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be positive`)
  }
}
