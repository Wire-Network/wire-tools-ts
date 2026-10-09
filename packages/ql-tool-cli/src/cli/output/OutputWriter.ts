import Fs from "node:fs"
import Path from "node:path"

import { getStdoutLogger } from "../../logger.js"

const stdout = getStdoutLogger()

/** Trailing line break of rendered text (the stdout appender adds its own). */
const TrailingNewlinePattern = /\n$/

/** Writes rendered output to stdout (the data channel) or a file. */
export namespace OutputWriter {
  /**
   * Write `text` to `output` (parent directories created) or, when no file is
   * given, to stdout.
   *
   * @param text - The rendered text.
   * @param output - Destination file; undefined = stdout.
   */
  export function write(text: string, output?: string): void {
    if (output != null) {
      Fs.mkdirSync(Path.dirname(Path.resolve(output)), { recursive: true })
      Fs.writeFileSync(output, text)
      return
    }
    stdout.info(text.replace(TrailingNewlinePattern, ""))
  }

  /**
   * Write lines to stdout (listings of the profile / history / saved / schema commands).
   *
   * @param lines - The lines.
   */
  export function writeLines(lines: string[]): void {
    lines.forEach(line => stdout.info(line))
  }
}
