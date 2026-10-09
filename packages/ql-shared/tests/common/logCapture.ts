import { getLoggingManager, Level, type Appender, type LogRecord } from "@wireio/shared"

/** Captures every log record while installed. */
export class LogCapture implements Appender<LogRecord> {
  /** Captured records. */
  readonly records: LogRecord[] = []
  private previousLevel: Level

  /** Route all logging here at debug level. */
  install(): this {
    this.previousLevel = getLoggingManager().rootLevel as Level
    getLoggingManager().setAppenders(this)
    getLoggingManager().setRootLevel(Level.debug)
    return this
  }

  /** Restore the root level (appenders stay captured, harmlessly). */
  uninstall(): void {
    getLoggingManager().setRootLevel(this.previousLevel)
  }

  /** Record one entry. */
  append(record: LogRecord): void {
    this.records.push(record)
  }

  /**
   * Messages at a level.
   *
   * @param level - The level.
   * @returns Matching messages.
   */
  messages(level: Level): string[] {
    return this.records.filter(record => record.level === level).map(record => record.message)
  }
}
