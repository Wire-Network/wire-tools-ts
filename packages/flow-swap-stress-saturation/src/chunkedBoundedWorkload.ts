import { runBoundedWorkload } from "@wireio/test-opp-stress"

type BurstWorkloadItem<Request> = {
  readonly workloadIndex: number
  readonly request: Request
}

type ChunkedWorkloadSuccess<Result> = {
  readonly index: number
  readonly id: Result
}

type ChunkedWorkloadFailure = {
  readonly index: number
  readonly reason: string
}

type ChunkedWorkloadResult<Result> = {
  readonly successes: readonly ChunkedWorkloadSuccess<Result>[]
  readonly failures: readonly ChunkedWorkloadFailure[]
}

/**
 * Run bounded workload chunks sequentially while preserving whole-burst indexes.
 *
 * @param options Requests, per-chunk concurrency, and indexed submitter.
 * @returns Success and failure telemetry keyed to original request positions.
 */
export async function runChunkedBoundedWorkload<Request, Result>(options: {
  readonly requests: readonly Request[]
  readonly concurrency: number
  readonly submit: (request: Request, index: number) => Promise<Result>
}): Promise<ChunkedWorkloadResult<Result>> {
  assertPositiveInteger(options.concurrency, "burst concurrency")
  const chunks = chunk(
    options.requests.map((request, workloadIndex) => ({
      workloadIndex,
      request
    })),
    options.concurrency
  )
  return chunks.reduce<Promise<ChunkedWorkloadResult<Result>>>(
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
  prior: ChunkedWorkloadResult<Result>,
  next: {
    readonly successes: readonly { readonly index: number; readonly id: Result }[]
    readonly failures: readonly { readonly index: number; readonly reason: string }[]
  },
  chunkItems: readonly BurstWorkloadItem<Request>[]
): ChunkedWorkloadResult<Result> {
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
