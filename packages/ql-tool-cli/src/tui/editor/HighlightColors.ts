import { HighlightTokenKind } from "@wireio/ql-shared"

/** Ink color per highlight class — covers every {@link HighlightTokenKind}. */
export const HighlightColors: Readonly<Record<HighlightTokenKind, string>> = {
  [HighlightTokenKind.keyword]: "blueBright",
  [HighlightTokenKind.aggregate]: "magentaBright",
  [HighlightTokenKind.identifier]: "white",
  [HighlightTokenKind.quotedIdentifier]: "cyan",
  [HighlightTokenKind.string]: "green",
  [HighlightTokenKind.number]: "yellow",
  [HighlightTokenKind.literal]: "yellowBright",
  [HighlightTokenKind.operator]: "gray",
  [HighlightTokenKind.punctuation]: "gray",
  [HighlightTokenKind.error]: "red"
}
