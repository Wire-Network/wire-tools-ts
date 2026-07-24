import {
  ClosedReason,
  StreamErrorCode,
  StreamFrameSchemaCodec,
  StreamFrameType,
  StreamTopic,
  type ClosedFrame,
  type ErrorFrame,
  type EventFrame,
  type StreamFrame,
  type SubscribeFrame,
  type SubscribedFrame,
  type UnsubscribeFrame
} from "@wireio/debugging-shared"

describe("StreamFrameType", () => {
  it("identity-maps every variant", () => {
    expect(StreamFrameType.Subscribe).toBe("subscribe")
    expect(StreamFrameType.Subscribed).toBe("subscribed")
    expect(StreamFrameType.Event).toBe("event")
    expect(StreamFrameType.Unsubscribe).toBe("unsubscribe")
    expect(StreamFrameType.Closed).toBe("closed")
    expect(StreamFrameType.Error).toBe("error")
  })
})

describe("StreamTopic", () => {
  it("uses kebab-case identity values for stable wire shape", () => {
    expect(StreamTopic.ProcessLiveness).toBe("process-liveness")
    expect(StreamTopic.LogTail).toBe("log-tail")
    expect(StreamTopic.EnvelopeWatch).toBe("envelope-watch")
  })
})

describe("StreamFrameSchemaCodec", () => {
  const subscribe: SubscribeFrame<StreamTopic.LogTail> = {
      type: StreamFrameType.Subscribe,
      id: 1,
      topic: StreamTopic.LogTail,
      params: { path: "/x/y.log" }
    },
    subscribed: SubscribedFrame = { type: StreamFrameType.Subscribed, id: 2 },
    event: EventFrame<StreamTopic.LogTail> = {
      type: StreamFrameType.Event,
      id: 3,
      payload: {
        path: "/x/y.log",
        appendedFromLine: 0,
        lines: [],
        totalBytes: 0,
        totalLines: 0,
        ino: 1
      }
    },
    unsubscribe: UnsubscribeFrame = { type: StreamFrameType.Unsubscribe, id: 4 },
    closed: ClosedFrame = {
      type: StreamFrameType.Closed,
      id: 5,
      reason: ClosedReason.ClientRequested
    },
    error: ErrorFrame = {
      type: StreamFrameType.Error,
      code: StreamErrorCode.UnknownTopic,
      message: "no such topic"
    },
    frames: StreamFrame[] = [
      subscribe,
      subscribed,
      event,
      unsubscribe,
      closed,
      error
    ]

  it("round-trips every frame variant through serialize → deserialize", () => {
    frames.forEach(frame =>
      expect(
        StreamFrameSchemaCodec.deserialize(
          StreamFrameSchemaCodec.serialize(frame)
        )
      ).toEqual(frame)
    )
  })

  it("check accepts every well-formed frame variant", () => {
    frames.forEach(frame =>
      expect(StreamFrameSchemaCodec.check(frame)).toBe(true)
    )
  })

  it("rejects non-frames, unknown types, and structurally-invalid frames", () => {
    expect(StreamFrameSchemaCodec.check(null)).toBe(false)
    expect(StreamFrameSchemaCodec.check("hi")).toBe(false)
    expect(StreamFrameSchemaCodec.check({ type: "bogus" })).toBe(false)
    // A Subscribed frame missing its required numeric id.
    expect(
      StreamFrameSchemaCodec.check({ type: StreamFrameType.Subscribed })
    ).toBe(false)
  })

  it("deserialize throws on a Closed frame with an out-of-set reason", () => {
    expect(() =>
      StreamFrameSchemaCodec.deserialize(
        JSON.stringify({
          type: StreamFrameType.Closed,
          id: 1,
          reason: "not-a-reason"
        })
      )
    ).toThrow()
  })
})
