import { ResultSearch } from "@wireio/ql-shared"

import { ResultsActions, UiActions, selectResultView, useAppDispatch, useAppSelector } from "../store/index.js"
import { PromptModal } from "./PromptModal.js"

/**
 * Find in results (`/`): the text highlights matching cells of the loaded page
 * and the cursor jumps to the first hit; an empty text clears the find.
 *
 * @returns The modal element.
 */
export function FindModal() {
  const dispatch = useAppDispatch(),
    findText = useAppSelector(state => state.results.findText),
    view = useAppSelector(state => selectResultView(state.results))
  return (
    <PromptModal
      title={FindModal.Title}
      initial={findText}
      hint={FindModal.Hint}
      onCancel={() => dispatch(UiActions.modalClosed())}
      onSubmit={text => {
        dispatch(ResultsActions.findTextSet(text))
        const first = view == null ? undefined : ResultSearch.find(view, text)[0]
        if (first != null) dispatch(ResultsActions.cursorPlaced(first.rowIndex))
        dispatch(UiActions.modalClosed())
      }}
    />
  )
}

/** Find constants. */
export namespace FindModal {
  /** Title. */
  export const Title = "Find in results (this page)"
  /** Hint. */
  export const Hint = "case-insensitive, over displayed cell text; empty clears"
}
