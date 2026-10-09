import { Either } from "@3fv/prelude-ts"

import type { PageWindow } from "@wireio/ql-shared"

/** Shown for a window or page without a limit (CLI diagnostics, TUI status and stats). */
export const NoLimitText = "none"

/** Separator of a window written as text (`offset,limit`). */
export const WindowTextSeparator = ","

/**
 * The ONE window-member rule of the CLI (`--offset` / `--limit`) and the TUI
 * window prompt: a non-negative integer.
 *
 * @param value - The offset or limit.
 * @returns Whether it is valid.
 */
export function isWindowMember(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

/**
 * Parse `offset,limit` (the limit may be omitted or empty = no limit). Exactly one
 * or two members — `1,2,3` is invalid.
 *
 * @param text - The window text.
 * @returns Right: the window — null for an empty text (clear the window); Left: the
 *   rejected text when it is not a window.
 */
export function parseWindowText(text: string): Either<string, PageWindow> {
  const trimmed = text.trim()
  if (trimmed.length === 0) return Either.right(null)
  const parts = trimmed.split(WindowTextSeparator).map(part => part.trim()),
    [offsetText, limitText = ""] = parts,
    offset = Number(offsetText),
    limit = limitText.length === 0 ? null : Number(limitText),
    valid = parts.length <= 2 && offsetText.length > 0 && isWindowMember(offset) && (limit == null || isWindowMember(limit))
  return valid ? Either.right({ offset, limit }) : Either.left(text)
}

/**
 * A window as `offset,limit` text (empty for none; an absent limit leaves the limit empty).
 *
 * @param window - The window, or null.
 * @returns The text.
 */
export function formatWindowText(window: PageWindow): string {
  return window == null ? "" : `${window.offset}${WindowTextSeparator}${window.limit ?? ""}`
}
