import {
  ClosedReason,
  StreamErrorCode,
  StreamFrameType,
  StreamTopic,
  isClosedFrame,
  isErrorFrame,
  isEventFrame,
  isStreamFrame,
  isSubscribeFrame,
  isSubscribedFrame,
  isUnsubscribeFrame,
  type ClosedFrame,
  type ErrorFrame,
  type EventFrame,
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

describe("isStreamFrame", () => {
  it("accepts every supported variant", () => {
    Object.values(StreamFrameType).forEach(type => {
      expect(isStreamFrame({ type })).toBe(true)
    })
  })

  it("rejects null / non-objects / unknown types", () => {
    expect(isStreamFrame(null)).toBe(false)
    expect(isStreamFrame(undefined)).toBe(false)
    expect(isStreamFrame("hi")).toBe(false)
    expect(isStreamFrame({ type: "bogus" })).toBe(false)
  })
})

describe("per-variant guards", () => {
  it("isSubscribeFrame narrows correctly", () => {
    const frame: SubscribeFrame<StreamTopic.LogTail> = {
      type: StreamFrameType.Subscribe,
      id: 1,
      topic: StreamTopic.LogTail,
      params: { path: "/x/y.log" }
    }
    expect(isSubscribeFrame(frame)).toBe(true)
    expect(isEventFrame(frame)).toBe(false)
  })

  it("isSubscribedFrame narrows correctly", () => {
    const frame: SubscribedFrame = { type: StreamFrameType.Subscribed, id: 1 }
    expect(isSubscribedFrame(frame)).toBe(true)
    expect(isClosedFrame(frame)).toBe(false)
  })

  it("isEventFrame narrows correctly", () => {
    const frame: EventFrame<StreamTopic.LogTail> = {
      type: StreamFrameType.Event,
      id: 1,
      payload: {
        path: "/x/y.log",
        appendedFromLine: 0,
        lines: [],
        totalBytes: 0,
        totalLines: 0,
        ino: 1
      }
    }
    expect(isEventFrame(frame)).toBe(true)
  })

  it("isUnsubscribeFrame narrows correctly", () => {
    const frame: UnsubscribeFrame = { type: StreamFrameType.Unsubscribe, id: 1 }
    expect(isUnsubscribeFrame(frame)).toBe(true)
  })

  it("isClosedFrame narrows correctly", () => {
    const frame: ClosedFrame = {
      type: StreamFrameType.Closed,
      id: 1,
      reason: ClosedReason.ClientRequested
    }
    expect(isClosedFrame(frame)).toBe(true)
  })

  it("isErrorFrame narrows correctly", () => {
    const frame: ErrorFrame = {
      type: StreamFrameType.Error,
      code: StreamErrorCode.UnknownTopic,
      message: "no such topic"
    }
    expect(isErrorFrame(frame)).toBe(true)
  })
})
