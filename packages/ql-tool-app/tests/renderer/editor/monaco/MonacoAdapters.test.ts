import type * as Monaco from "monaco-editor"

import { CompletionKind, HighlightTokenKind, QueryErrorCode, QueryErrorKind, QueryFailureKind, SyntaxHighlighter } from "@wireio/ql-shared"

import {
  Completion,
  Diagnostics,
  Hover,
  SemanticTokens,
  WireQueryLanguage
} from "@wireio/ql-tool-app/renderer/editor/monaco"
import { createQLTheme } from "@wireio/ql-tool-app/renderer/theme"

import * as monacoMock from "../../../__mocks__/monaco-editor.js"
import { CatalogFixtures } from "../../../common/CatalogFixtures.js"

const monaco = monacoMock as unknown as typeof Monaco

/**
 * A single-line fake text model.
 *
 * @param text - Model text (one line).
 * @returns The model.
 */
function modelOf(text: string): Monaco.editor.ITextModel {
  const wordAt = (column: number) => {
    const before = /[\w.]*$/.exec(text.slice(0, column - 1))[0].replace(/.*\./, ""),
      after = /^\w*/.exec(text.slice(column - 1))[0]
    return { word: before + after, startColumn: column - before.length, endColumn: column + after.length }
  }
  return {
    getValue: () => text,
    getOffsetAt: (position: Monaco.Position) => position.column - 1,
    getWordUntilPosition: (position: Monaco.Position) => {
      const word = wordAt(position.column)
      return { ...word, endColumn: position.column }
    },
    getWordAtPosition: (position: Monaco.Position) => {
      const word = wordAt(position.column)
      return word.word.length === 0 ? null : word
    }
  } as unknown as Monaco.editor.ITextModel
}

/** A position on line 1. */
function at(column: number): Monaco.Position {
  return { lineNumber: 1, column } as Monaco.Position
}

describe("SemanticTokens", () => {
  it("encodes classified tokens as relative 5-tuples with legend indices", () => {
    const text = "SELECT name\nFROM sample.positions",
      data = SemanticTokens.encode(text, SyntaxHighlighter.classify(text))
    expect(data.length % SemanticTokens.EncodedWidth).toBe(0)
    expect(Array.from(data.slice(0, 5))).toEqual([0, 0, 6, SemanticTokens.TokenTypes.indexOf(HighlightTokenKind.keyword), 0])
    const fromRow = Array.from(data).findIndex((_value, index, all) => index % 5 === 0 && all[index] === 1)
    expect(Array.from(data.slice(fromRow, fromRow + 3))).toEqual([1, 0, 4])
  })

  it("an empty document encodes to nothing; the range provider keeps only the requested lines", () => {
    expect(SemanticTokens.encode("", [])).toHaveLength(0)
    const provider = SemanticTokens.createProvider(),
      result = provider.provideDocumentRangeSemanticTokens(
        modelOf("SELECT 1"),
        { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 } as Monaco.Range,
        null
      ) as Monaco.languages.SemanticTokens
    expect(result.data).toHaveLength(0)
    expect(SemanticTokens.legend().tokenTypes).toEqual([...SemanticTokens.TokenTypes])
  })
})

describe("Completion", () => {
  it("maps candidate kinds onto Monaco item kinds", () => {
    expect(Completion.itemKindOf(monaco, CompletionKind.keyword)).toBe(monacoMock.languages.CompletionItemKind.Keyword)
    expect(Completion.itemKindOf(monaco, CompletionKind.field)).toBe(monacoMock.languages.CompletionItemKind.Field)
  })

  it("suggests the owner's tables after `owner.` replacing the typed word", () => {
    const provider = Completion.createProvider(monaco, () => CatalogFixtures.loaded()),
      text = "SELECT * FROM sample.po",
      { suggestions } = provider.provideCompletionItems(
        modelOf(text),
        at(text.length + 1),
        null,
        null
      ) as Monaco.languages.CompletionList
    expect(suggestions.map(item => item.label)).toContain("positions")
    expect((suggestions[0].range as Monaco.IRange).startColumn).toBe(text.length - 1)
  })

  it("no snapshot yet → no suggestions", () => {
    const provider = Completion.createProvider(monaco, () => null),
      result = provider.provideCompletionItems(modelOf("SEL"), at(4), null, null) as Monaco.languages.CompletionList
    expect(result.suggestions).toEqual([])
  })
})

describe("Hover", () => {
  it("shows ABI + logical type of matching fields", () => {
    const hover = Hover.createProvider(() => CatalogFixtures.loaded()).provideHover(
      modelOf("SELECT name FROM sample.positions"),
      at(9),
      null
    ) as Monaco.languages.Hover
    expect(hover.contents).toEqual([{ value: "`sample.positions.name` — value · name · text" }])
  })

  it("unknown words, whitespace and a missing snapshot give no hover", () => {
    const provider = Hover.createProvider(() => CatalogFixtures.loaded())
    expect(provider.provideHover(modelOf("SELECT zzz"), at(9), null)).toBeNull()
    expect(provider.provideHover(modelOf("SELECT  "), at(8), null)).toBeNull()
    expect(Hover.createProvider(() => null).provideHover(modelOf("name"), at(2), null)).toBeNull()
    expect(Hover.fieldsNamed(CatalogFixtures.loaded(), "id").map(([name]) => name)).toEqual(["sample.positions.key.id"])
  })
})

describe("Diagnostics", () => {
  beforeEach(() => monacoMock.editor.setModelMarkers.mockClear())

  it("grammar markers for a syntax error; none for valid SQL", () => {
    Diagnostics.applyGrammarMarkers(monaco, modelOf("SELECT FROM"))
    const [, owner, markers] = monacoMock.editor.setModelMarkers.mock.calls[0]
    expect(owner).toBe(Diagnostics.GrammarOwner)
    expect(markers.length).toBeGreaterThan(0)
    expect(markers[0].severity).toBe(monacoMock.MarkerSeverity.Error)
    Diagnostics.applyGrammarMarkers(monaco, modelOf("SELECT * FROM sample.positions"))
    expect(monacoMock.editor.setModelMarkers.mock.calls[1][2]).toEqual([])
  })

  it("engine failure markers at the reported position; null / positionless clears", () => {
    const query = "SELECT * FROM sample.positions JOIN x",
      data = { kind: QueryErrorKind.QUERY_SYNTAX, retryable: false, line: 1, column: 32, limit: null },
      failure = { kind: QueryFailureKind.engine, message: "JOIN is not supported", code: QueryErrorCode.QUERY_SYNTAX, data }
    Diagnostics.applyEngineFailure(monaco, modelOf(query), failure, query)
    expect(monacoMock.editor.setModelMarkers.mock.calls[0][2][0]).toMatchObject({
      startLineNumber: 1,
      startColumn: 32,
      message: "JOIN is not supported"
    })
    Diagnostics.applyEngineFailure(monaco, modelOf(query), { ...failure, data: { ...data, line: null } }, query)
    Diagnostics.applyEngineFailure(monaco, modelOf(query), null, query)
    expect(monacoMock.editor.setModelMarkers.mock.calls.slice(1).map(([, owner, markers]) => [owner, markers])).toEqual([
      [Diagnostics.EngineOwner, []],
      [Diagnostics.EngineOwner, []]
    ])
  })
})

describe("WireQueryLanguage", () => {
  it("registers the language once, both themes and all three providers; dispose releases them", () => {
    monacoMock.languages.registered.length = 0
    const first = WireQueryLanguage.register(monaco, () => null)
    WireQueryLanguage.register(monaco, () => null)
    expect(monacoMock.languages.registered.filter(language => language.id === WireQueryLanguage.Id)).toHaveLength(1)
    expect(monacoMock.editor.defineTheme.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([WireQueryLanguage.LightTheme, WireQueryLanguage.DarkTheme])
    )
    const bases = Object.fromEntries(monacoMock.editor.defineTheme.mock.calls.map(([name, theme]) => [name, theme.base]))
    expect(bases).toMatchObject({
      [WireQueryLanguage.LightTheme]: createQLTheme.MonacoLightTheme,
      [WireQueryLanguage.DarkTheme]: createQLTheme.MonacoDarkTheme
    })
    const disposable = monacoMock.languages.registerHoverProvider.mock.results[0].value
    first.dispose()
    expect(disposable.dispose).toHaveBeenCalled()
  })

  it("themes color every highlight kind; keywords use the brand blue", () => {
    const rules = WireQueryLanguage.themeRules(WireQueryLanguage.LightColors)
    expect(rules).toHaveLength(Object.values(HighlightTokenKind).length)
    expect(rules.find(rule => rule.token === HighlightTokenKind.keyword).foreground).toBe("2F6BFF")
    expect(WireQueryLanguage.themeOf(true)).toBe(WireQueryLanguage.DarkTheme)
    expect(WireQueryLanguage.themeOf(false)).toBe(WireQueryLanguage.LightTheme)
  })
})
