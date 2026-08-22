/**
 * nodeop `config.ini` rendering helpers — the single source of truth for how a
 * key/value pair becomes an ini line, shared by every renderer that emits one.
 */

/** The values a nodeop ini key may carry (booleans render as `true` / `false`). */
export type IniValue = string | number | boolean

/**
 * Render ONE nodeop `config.ini` line — `<key> = <value>`.
 *
 * nodeop's option parser is whitespace-tolerant around the `=`, but the spacing
 * below is what every emitted cluster + API-node ini has always used, and the
 * suites assert on it verbatim; changing it changes every rendered config file.
 *
 * @param key - The nodeop option name (the bare form, no leading `--`).
 * @param value - The value to render; stringified as-is.
 * @returns The `<key> = <value>` line, without a trailing newline.
 */
export function toIniLine(key: string, value: IniValue): string {
  return `${key} = ${String(value)}`
}
