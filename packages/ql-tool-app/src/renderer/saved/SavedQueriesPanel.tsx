import Button from "@mui/material/Button"

import { QueryDrawer, QueryListItem } from "../components/index.js"
import {
  openAndRunQuery,
  removeSaved,
  UiActions,
  UiSurface,
  useAppDispatch,
  useAppSelector,
  WorkspaceActions
} from "../store/index.js"

/**
 * Saved queries / snippets (shared `saved-queries.json` with `wql`): open in a
 * new tab (click), re-run in a new tab (Re-run), delete, save the current editor.
 *
 * @returns The drawer.
 */
export function SavedQueriesPanel() {
  const dispatch = useAppDispatch(),
    queries = useAppSelector(state => state.saved.queries)
  return (
    <QueryDrawer
      surface={UiSurface.saved}
      title="Saved Queries"
      listTestId="saved-list"
      actions={
        <Button size="small" onClick={() => dispatch(UiActions.surfaceOpened(UiSurface.saveQuery))}>
          Save current…
        </Button>
      }
    >
      {queries.map(saved => (
        <QueryListItem
          key={saved.id}
          primary={saved.name}
          secondary={saved.query}
          identity={saved.name}
          onOpen={() => dispatch(WorkspaceActions.tabAdded({ text: saved.query, title: saved.name }))}
          onRerun={() => void dispatch(openAndRunQuery({ text: saved.query, title: saved.name }))}
          onDelete={() => void dispatch(removeSaved(saved.id))}
        />
      ))}
    </QueryDrawer>
  )
}
