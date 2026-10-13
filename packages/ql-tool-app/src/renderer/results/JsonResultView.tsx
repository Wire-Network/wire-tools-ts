import Editor from "@monaco-editor/react"

import type { ResultView } from "@wireio/ql-shared"

import { MonacoOptions, useMonacoTheme } from "../editor/index.js"

/** Props of {@link JsonResultView}. */
export interface JsonResultViewProps {
  /** The view rendered (this page's rows, client view applied). */
  view: ResultView
}

/**
 * The rows as pretty JSON in a read-only Monaco editor.
 *
 * @param props - The view.
 * @returns The JSON view.
 */
export function JsonResultView({ view }: JsonResultViewProps) {
  const theme = useMonacoTheme(),
    text = JSON.stringify(view.rows(view.fullRange()), null, JsonResultView.Indent)
  return <Editor language={JsonResultView.Language} value={text} theme={theme} options={JsonResultView.Options} />
}

/** JSON-view constants. */
export namespace JsonResultView {
  /** Monaco language of the view. */
  export const Language = "json"
  /** JSON indent. */
  export const Indent = 2
  /** Read-only editor over the shared base options. */
  export const Options = { ...MonacoOptions.base, readOnly: true }
}
