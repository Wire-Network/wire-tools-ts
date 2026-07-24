/** Request submitted by a bounded OPP stress workload. */
export type BoundedWorkloadRequest<Request> = {
  /** Stable request index used for telemetry. */
  readonly index: number
  /** Workload-specific request payload. */
  readonly request: Request
}

/** Successful bounded workload submission. */
export type BoundedWorkloadSuccess<Result> = {
  /** Stable request index. */
  readonly index: number
  /** Submitted transaction id, signature, or caller-provided success result. */
  readonly id: Result
}

/** Failed bounded workload submission. */
export type BoundedWorkloadFailure = {
  /** Stable request index. */
  readonly index: number
  /** Failure reason captured without stopping sibling submissions. */
  readonly reason: string
}

/** Telemetry from one concurrency-only workload burst. */
export type BoundedWorkloadResult<Result> = {
  /** Successful submissions in request order. */
  readonly successes: readonly BoundedWorkloadSuccess<Result>[]
  /** Failed submissions in request order. */
  readonly failures: readonly BoundedWorkloadFailure[]
}

/** Options for bounded workload execution. */
export type BoundedWorkloadOptions<Request, Result> = {
  /** Requests to submit immediately, bounded only by `concurrency`. */
  readonly requests: readonly Request[]
  /** Maximum in-flight submissions. This is the only execution bound. */
  readonly concurrency: number
  /** Submit one request and return its transaction id or equivalent telemetry. */
  readonly submit: (request: Request, index: number) => Promise<Result>
}

type WorkloadItemResult<Result> =
  | {
      readonly kind: "success"
      readonly success: BoundedWorkloadSuccess<Result>
    }
  | { readonly kind: "failure"; readonly failure: BoundedWorkloadFailure }

/**
 * Submit every request with bounded in-flight concurrency only.
 *
 * @param options Requests, concurrency cap, and submitter.
 * @returns Per-request success and failure telemetry.
 */
export async function runBoundedWorkload<Request, Result>(
  options: BoundedWorkloadOptions<Request, Result>
): Promise<BoundedWorkloadResult<Result>> {
  assertPositiveInteger(options.concurrency, "workload concurrency")
  const indexedRequests = options.requests.map((request, index) => ({
      index,
      request
    })),
    results = await runConcurrent(
      indexedRequests,
      options.concurrency,
      request => submitRequest(options.submit, request)
    )
  return collectResults(results)
}

async function submitRequest<Request, Result>(
  submit: (request: Request, index: number) => Promise<Result>,
  request: BoundedWorkloadRequest<Request>
): Promise<WorkloadItemResult<Result>> {
  try {
    return {
      kind: "success",
      success: {
        index: request.index,
        id: await submit(request.request, request.index)
      }
    }
  } catch (error) {
    return {
      kind: "failure",
      failure: { index: request.index, reason: errorMessage(error) }
    }
  }
}

async function runConcurrent<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  worker: (item: Item) => Promise<Result>
): Promise<readonly Result[]> {
  const nextIndex = { value: 0 },
    results: Result[] = []
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      runWorker(items, worker, nextIndex, results)
    )
  )
  return results
}

async function runWorker<Item, Result>(
  items: readonly Item[],
  worker: (item: Item) => Promise<Result>,
  nextIndex: { value: number },
  results: Result[]
): Promise<void> {
  const index = nextIndex.value
  nextIndex.value += 1
  const item = items[index]
  if (item === undefined) return
  results[index] = await worker(item)
  await runWorker(items, worker, nextIndex, results)
}

function collectResults<Result>(
  results: readonly WorkloadItemResult<Result>[]
): BoundedWorkloadResult<Result> {
  return {
    successes: results
      .filter(
        (
          result
        ): result is Extract<
          WorkloadItemResult<Result>,
          { readonly kind: "success" }
        > => result.kind === "success"
      )
      .map(result => result.success),
    failures: results
      .filter(
        (
          result
        ): result is Extract<
          WorkloadItemResult<Result>,
          { readonly kind: "failure" }
        > => result.kind === "failure"
      )
      .map(result => result.failure)
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${label} must be positive`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
