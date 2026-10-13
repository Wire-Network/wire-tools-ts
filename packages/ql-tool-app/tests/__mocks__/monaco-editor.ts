/**
 * A minimal Monaco API stand-in for the `wirequery` language adapters: records
 * registrations, markers and themes; enums carry Monaco's numeric values.
 */
export const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512 }
export const KeyCode = { Enter: 3, KeyF: 36 }
export const MarkerSeverity = { Error: 8 }

/** Range constructor. */
export class Range {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number
  ) {}
}

/** A registered language. */
export interface MockLanguage {
  id: string
}

/** Recorded language registrations. */
export const languages = {
  registered: [] as MockLanguage[],
  CompletionItemKind: { Keyword: 17, Function: 1, Module: 8, Struct: 6, Field: 3 },
  getLanguages: jest.fn(() => languages.registered),
  register: jest.fn((language: MockLanguage) => languages.registered.push(language)),
  registerDocumentRangeSemanticTokensProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerCompletionItemProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerHoverProvider: jest.fn(() => ({ dispose: jest.fn() }))
}

/** Recorded editor calls. */
export const editor = {
  defineTheme: jest.fn(),
  setModelMarkers: jest.fn()
}
