/** Line output shared by every text renderer. */
export namespace textLines {
  /** Line separator of every rendered text format. */
  export const LineSeparator = "\n"

  /**
   * Join output lines, each terminated by {@link LineSeparator}.
   *
   * @param lines - The lines.
   * @returns The text (empty for no lines).
   */
  export function render(lines: string[]): string {
    return lines.map(line => `${line}${LineSeparator}`).join("")
  }
}
