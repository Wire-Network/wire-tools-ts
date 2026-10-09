import { getLoggingManager, Level, type LogRecord } from "@wireio/shared"

import { BridgeLogAppender, LogRecordPayloadSchema, type LogRecordPayload } from "@wireio/ql-tool-app/common"

/** Fixture constants. */
namespace Fixture {
  export const Category = "renderer:App"
  export const Timestamp = 1_700_000_000_000
}

/**
 * A logger record.
 *
 * @param message - The message.
 * @param args - Extra arguments.
 * @returns The record.
 */
function recordOf(message: string, args: unknown[] = []): LogRecord {
  return { category: Fixture.Category, level: Level.warn, message, timestamp: Fixture.Timestamp, args } as LogRecord
}

describe("BridgeLogAppender", () => {
  it("forwards a schema-valid payload with the sender's category", () => {
    const sent: LogRecordPayload[] = [],
      appender = new BridgeLogAppender(payload => sent.push(payload))
    appender.append(recordOf("hello"))
    expect(sent).toEqual([
      { category: Fixture.Category, level: Level.warn, message: "hello", timestamp: Fixture.Timestamp }
    ])
    expect(LogRecordPayloadSchema.safeParse(sent[0]).success).toBe(true)
  })

  it("appends extra arguments as text (errors by stack, strings as-is, objects as JSON)", () => {
    const error = new Error("boom"),
      payload = BridgeLogAppender.toPayload(recordOf("failed", [error, "detail", { id: 7 }]))
    expect(payload.message).toBe(`failed ${error.stack} detail {"id":7}`)
    expect(payload.message).toContain("BridgeLogAppender.test")
  })

  it("describeArgument is bigint- and cycle-safe and falls back to the message without a stack", () => {
    const cyclic: Record<string, unknown> = { name: "loop" }
    cyclic.self = cyclic
    const stackless = Object.assign(new Error("no trace"), { stack: undefined })
    expect(BridgeLogAppender.describeArgument({ total: 12n })).toBe('{"total":"12"}')
    expect(BridgeLogAppender.describeArgument(cyclic)).toBe("[object Object]")
    expect(BridgeLogAppender.describeArgument(undefined)).toBe("undefined")
    expect(BridgeLogAppender.describeArgument(stackless)).toBe("no trace")
  })

  it("a record without args keeps only the message", () => {
    const { args: _args, ...record } = recordOf("bare")
    expect(BridgeLogAppender.toPayload(record as LogRecord).message).toBe("bare")
  })

  it("the payload schema rejects an empty category and unknown keys", () => {
    const valid = BridgeLogAppender.toPayload(recordOf("x"))
    expect(LogRecordPayloadSchema.safeParse({ ...valid, category: "" }).success).toBe(false)
    expect(LogRecordPayloadSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
  })
})

describe("BridgeLogAppender.install", () => {
  const manager = getLoggingManager(),
    previous = { appenders: [...manager.appenders], level: manager.rootLevel }

  afterEach(() => {
    manager.setAppenders(previous.appenders).setRootLevel(previous.level)
  })

  it("routes every logger through ONE bridge appender at the forwarding level (main applies LOG_LEVEL)", () => {
    const sent: LogRecordPayload[] = [],
      appender = BridgeLogAppender.install(payload => sent.push(payload))
    expect(manager.appenders).toEqual([appender])
    expect(manager.rootLevel).toBe(BridgeLogAppender.ForwardingLevel)
    appender.append(recordOf("routed"))
    expect(sent.map(payload => payload.message)).toEqual(["routed"])
  })

  it("installing again replaces the previous appender", () => {
    BridgeLogAppender.install(jest.fn())
    const second = BridgeLogAppender.install(jest.fn())
    expect(manager.appenders).toEqual([second])
  })
})
