import type * as Monaco from "monaco-editor"

import { HighlightTokenKind, QLBrand } from "@wireio/ql-shared"

import { createQLTheme } from "../../theme/index.js"
import { Completion, type SnapshotSource } from "./completion.js"
import { Hover } from "./hover.js"
import { SemanticTokens } from "./semanticTokens.js"

/** The `wirequery` Monaco language: semantic tokens, completion, hover and themes. */
export namespace WireQueryLanguage {
  /** Language id. */
  export const Id = "wirequery"
  /** Light theme name. */
  export const LightTheme = "wirequery-light"
  /** Dark theme name. */
  export const DarkTheme = "wirequery-dark"
  /** Editor option enabling semantic highlighting. */
  export const SemanticHighlightingOption = "semanticHighlighting.enabled"

  /** Token colors per scheme (hex without `#`). */
  export const LightColors: Readonly<Record<HighlightTokenKind, string>> = {
    [HighlightTokenKind.keyword]: QLBrand.PrimaryHex.slice(1),
    [HighlightTokenKind.aggregate]: "8250DF",
    [HighlightTokenKind.identifier]: "1F2328",
    [HighlightTokenKind.quotedIdentifier]: "0550AE",
    [HighlightTokenKind.string]: "0A7F3F",
    [HighlightTokenKind.number]: "B35900",
    [HighlightTokenKind.literal]: "B35900",
    [HighlightTokenKind.operator]: "57606A",
    [HighlightTokenKind.punctuation]: "57606A",
    [HighlightTokenKind.error]: "CF222E"
  }
  /** Dark-scheme token colors. */
  export const DarkColors: Readonly<Record<HighlightTokenKind, string>> = {
    [HighlightTokenKind.keyword]: "6E9BFF",
    [HighlightTokenKind.aggregate]: "D2A8FF",
    [HighlightTokenKind.identifier]: "E6EDF3",
    [HighlightTokenKind.quotedIdentifier]: "79C0FF",
    [HighlightTokenKind.string]: "7EE787",
    [HighlightTokenKind.number]: "FFA657",
    [HighlightTokenKind.literal]: "FFA657",
    [HighlightTokenKind.operator]: "8B949E",
    [HighlightTokenKind.punctuation]: "8B949E",
    [HighlightTokenKind.error]: "FF7B72"
  }

  /**
   * Theme rules for every highlight kind.
   *
   * @param colors - Per-kind colors.
   * @returns The rules.
   */
  export function themeRules(colors: Readonly<Record<HighlightTokenKind, string>>): Monaco.editor.ITokenThemeRule[] {
    return Object.values(HighlightTokenKind).map(kind => ({ token: kind, foreground: colors[kind] }))
  }

  /**
   * Register the language, its providers and both themes (idempotent per Monaco instance).
   *
   * @param monaco - The Monaco API.
   * @param snapshot - Latest catalog snapshot (completion + hover).
   * @returns Disposes the providers.
   */
  export function register(monaco: typeof Monaco, snapshot: SnapshotSource): Monaco.IDisposable {
    if (!monaco.languages.getLanguages().some(language => language.id === Id)) {
      monaco.languages.register({ id: Id, aliases: ["WireQuery", "wql"] })
    }
    monaco.editor.defineTheme(LightTheme, {
      base: createQLTheme.MonacoLightTheme,
      inherit: true,
      rules: themeRules(LightColors),
      colors: {}
    })
    monaco.editor.defineTheme(DarkTheme, {
      base: createQLTheme.MonacoDarkTheme,
      inherit: true,
      rules: themeRules(DarkColors),
      colors: {}
    })
    const disposables = [
      monaco.languages.registerDocumentRangeSemanticTokensProvider(Id, SemanticTokens.createProvider()),
      monaco.languages.registerCompletionItemProvider(Id, Completion.createProvider(monaco, snapshot)),
      monaco.languages.registerHoverProvider(Id, Hover.createProvider(snapshot))
    ]
    return { dispose: () => disposables.forEach(disposable => disposable.dispose()) }
  }

  /**
   * The theme of a scheme.
   *
   * @param dark - Whether the dark scheme is active.
   * @returns The theme name.
   */
  export function themeOf(dark: boolean): string {
    return dark ? DarkTheme : LightTheme
  }
}
