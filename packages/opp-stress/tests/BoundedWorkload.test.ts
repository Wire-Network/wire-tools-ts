import { runBoundedWorkload } from "@wireio/test-opp-stress"

describe("runBoundedWorkload", () => {
  it("submits every request with only bounded in-flight work", async () => {
    // Given: five requests and a concurrency-only cap of two.
    const requests = [0, 1, 2, 3, 4]
    let active = 0
    let maxActive = 0
    const started: number[] = []

    // When: the bounded workload runs.
    const result = await runBoundedWorkload({
      requests,
      concurrency: 2,
      submit: async request => {
        active += 1
        maxActive = Math.max(maxActive, active)
        started.push(request)
        await Promise.resolve()
        active -= 1
        return `tx-${request}`
      }
    })

    // Then: every request is submitted without exceeding the in-flight cap.
    expect(started).toEqual(requests)
    expect(maxActive).toBe(2)
    expect(result.failures).toEqual([])
    expect(result.successes.map(success => success.id)).toEqual([
      "tx-0",
      "tx-1",
      "tx-2",
      "tx-3",
      "tx-4"
    ])
  })

  it("captures request failures as telemetry without stopping the burst", async () => {
    // Given: one request throws while the rest can succeed.
    const requests = [0, 1, 2]

    // When: the bounded workload runs.
    const result = await runBoundedWorkload({
      requests,
      concurrency: 3,
      submit: async request => {
        if (request === 1) throw new Error("injected failure")
        return `tx-${request}`
      }
    })

    // Then: successes and failures are both retained in request order.
    expect(result.successes.map(success => success.index)).toEqual([0, 2])
    expect(result.failures).toEqual([{ index: 1, reason: "injected failure" }])
  })

  it("starts the next request as soon as one in-flight slot frees", async () => {
    // Given: request 1 remains in flight after request 0 completes.
    const gates = createGates(3),
      started: number[] = [],
      workload = runBoundedWorkload({
        requests: [0, 1, 2],
        concurrency: 2,
        submit: async request => {
          started.push(request)
          await gates[request].promise
          return `tx-${request}`
        }
      })
    await Promise.resolve()
    expect(started).toEqual([0, 1])

    // When: one slot frees while another request is still active.
    gates[0].resolve()
    await flushMicrotasks()

    // Then: request 2 starts immediately instead of waiting for the full first batch.
    expect(started).toEqual([0, 1, 2])
    gates[1].resolve()
    gates[2].resolve()
    expect((await workload).successes.map(success => success.id)).toEqual([
      "tx-0",
      "tx-1",
      "tx-2"
    ])
  })
})

type Gate = {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createGates(count: number): readonly Gate[] {
  return Array.from({ length: count }, () => {
    let resolveGate: () => void = () => undefined
    const promise = new Promise<void>(resolve => {
      resolveGate = resolve
    })
    return { promise, resolve: resolveGate }
  })
}
