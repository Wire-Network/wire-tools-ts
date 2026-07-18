import React from "react"
import { Text } from "ink"

/** Constants shared by the line-rendering helpers. */
export namespace LineRender {
  /** Regex metacharacters that must be backslash-escaped to be used as literals. */
  export const MetacharRegex = /[.*+?^${}()|[\]\\]/g
  /** Replacement string that prefixes every metachar match with a backslash. */
  export const EscapeReplace = "\\$&"
  /** Flags used by the highlight regex — case-insensitive global. */
  export const HighlightRegexFlags = "gi" as const
  /** Surrounding character that opts a search term into JS-style regex mode (`/pattern/`). */
  export const RegexDelimiter = "/" as const
  /**
   * Ink wrap mode used for log-viewer lines. Truncates the rendered string at
   * the right edge of the viewport so a single source line always occupies
   * exactly one terminal row — wrapping would let lines spill onto a second
   * visual row and be overdrawn by the next list item.
   */
  export const TruncateMode = "truncate-end" as const
}

/**
 * Drop the first `offset` characters when `offset` is positive and within the
 * string's bounds. Used by `LogViewerJSONLine` / `LogViewerTextLine` to apply
 * the panel's horizontal-scroll state.
 */
export function sliceForHorizontalOffset(s: string, offset: number): string {
  return offset > 0 && offset < s.length ? s.slice(offset) : s
}

/** Escape a literal substring so it can be embedded in a regex without metachar pitfalls. */
function escapeRegex(literal: string): string {
  return literal.replace(LineRender.MetacharRegex, LineRender.EscapeReplace)
}

/**
 * Compile a search query into a case-insensitive global regex. Two modes:
 *
 *   - `/pattern/` (slash-delimited, JS-style): inner pattern is used verbatim.
 *     Compile failure → null (caller treats as no-op / no highlight).
 *   - anything else: literal substring; metachars are escaped.
 *
 * Empty / single-`/` / `//` / unclosed-regex inputs all resolve to `null`.
 */
export function compileSearchRegex(query: string): RegExp | null {
  if (query.length === 0) return null
  const isRegex =
      query.length >= 2 &&
      query.startsWith(LineRender.RegexDelimiter) &&
      query.endsWith(LineRender.RegexDelimiter),
    inner = isRegex ? query.slice(1, -1) : escapeRegex(query)
  if (inner.length === 0) return null
  try {
    return new RegExp(inner, LineRender.HighlightRegexFlags)
  } catch {
    return null
  }
}

/** Cumulative render state threaded through the matchAll reduction. */
interface HighlightSegments {
  cursor: number
  nodes: React.ReactNode[]
}

/**
 * Split `text` around `term`; render matches in inverse video. Returns a
 * single `<Text>` when `term` is empty / unparseable / yields no matches so
 * callers can drop this in unconditionally. Term semantics:
 *
 *   - `/pattern/` → JS-style regex (case-insensitive, global)
 *   - anything else → case-insensitive literal substring
 *
 * Match length comes from the regex result (regex matches can vary in
 * length per hit), not from `term.length` — required for regex mode to
 * highlight the actual matched span rather than the literal pattern.
 *
 * @param text  text to render
 * @param term  search term — empty string disables highlighting
 */
export function renderWithHighlight(
  text: string,
  term: string
): React.ReactNode {
  const regex = compileSearchRegex(term)
  if (!regex) return <Text>{text}</Text>
  const matches = [...text.matchAll(regex)]
  if (matches.length === 0) return <Text>{text}</Text>
  const initial: HighlightSegments = { cursor: 0, nodes: [] },
    segments = matches.reduce<HighlightSegments>(({ cursor, nodes }, m, i) => {
      const { index: idx = cursor } = m,
        matched = m[0],
        next = idx + matched.length,
        leading =
          idx > cursor
            ? [<Text key={`pre-${i}`}>{text.slice(cursor, idx)}</Text>]
            : [],
        hit = (
          <Text key={`hit-${i}`} inverse>
            {matched}
          </Text>
        )
      return { cursor: next, nodes: [...nodes, ...leading, hit] }
    }, initial),
    tail =
      segments.cursor < text.length
        ? [<Text key="tail">{text.slice(segments.cursor)}</Text>]
        : []
  return <>{[...segments.nodes, ...tail]}</>
}
