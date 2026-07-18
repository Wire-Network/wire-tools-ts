import { ClosedReason, StreamTopic } from "@wireio/debugging-shared"

import {
  DebuggingSubscription,
  DebuggingSubscriptionEventName
} from "@wireio/debugging-client-shared"

describe("DebuggingSubscription", () => {
  it("invokes onClose exactly once on close()", () => {
    const onClose = jest.fn()
    const sub = new DebuggingSubscription<number>(
      1,
      StreamTopic.LogTail,
      onClose
    )
    sub.close(ClosedReason.ClientRequested)
    sub.close(ClosedReason.ClientRequested)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("emits 'closed' to listeners with the reason", () => {
    const sub = new DebuggingSubscription<number>(
      1,
      StreamTopic.LogTail,
      () => {}
    )
    const reasons: ClosedReason[] = []
    sub.on(DebuggingSubscriptionEventName.Closed, r => reasons.push(r))
    sub.close(ClosedReason.ServerShutdown)
    expect(reasons).toEqual([ClosedReason.ServerShutdown])
  })

  it("emits typed event payloads", () => {
    const sub = new DebuggingSubscription<{ n: number }>(
      1,
      StreamTopic.LogTail,
      () => {}
    )
    const received: { n: number }[] = []
    sub.on(DebuggingSubscriptionEventName.Event, e => received.push(e))
    sub.emitEvent({ n: 42 })
    sub.emitEvent({ n: 7 })
    expect(received).toEqual([{ n: 42 }, { n: 7 }])
  })

  it("notifyClosed by transport short-circuits subsequent close()", () => {
    const onClose = jest.fn()
    const sub = new DebuggingSubscription<number>(
      1,
      StreamTopic.LogTail,
      onClose
    )
    sub.notifyClosed(ClosedReason.ServerShutdown)
    sub.close(ClosedReason.ClientRequested)
    expect(onClose).not.toHaveBeenCalled()
    expect(sub.isClosed()).toBe(true)
  })

  it("buffers events emitted before any listener is attached and drains them on attach", async () => {
    const sub = new DebuggingSubscription<number>(
      1,
      StreamTopic.LogTail,
      () => {}
    )
    // No listener — these would normally be lost.
    sub.emitEvent(1)
    sub.emitEvent(2)
    sub.emitEvent(3)
    const received: number[] = []
    sub.on(DebuggingSubscriptionEventName.Event, n => received.push(n))
    // Drained on next tick.
    await new Promise(r => setImmediate(r))
    expect(received).toEqual([1, 2, 3])
  })

  it("buffers a pre-listener close and surfaces it on attach", async () => {
    const sub = new DebuggingSubscription<number>(
      1,
      StreamTopic.LogTail,
      () => {}
    )
    sub.notifyClosed(ClosedReason.ServerShutdown)
    let captured: ClosedReason | null = null
    sub.on(DebuggingSubscriptionEventName.Closed, r => (captured = r))
    await new Promise(r => setImmediate(r))
    expect(captured).toBe(ClosedReason.ServerShutdown)
  })
})
