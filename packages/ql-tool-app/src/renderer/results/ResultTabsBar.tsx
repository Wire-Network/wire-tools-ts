import PushPinIcon from "@mui/icons-material/PushPin"
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined"
import Tab from "@mui/material/Tab"
import Tabs from "@mui/material/Tabs"

import { ClosableTabLabel } from "../components/index.js"
import { ResultsActions, ResultTabStatus, useAppDispatch, useAppSelector, type ResultTab } from "../store/index.js"

/**
 * The result tabs (multiple results kept; a PINNED tab is never replaced by the
 * next run).
 *
 * @returns The tab strip.
 */
export function ResultTabsBar() {
  const dispatch = useAppDispatch(),
    { tabs, activeResultId } = useAppSelector(state => state.results)
  if (tabs.length === 0) return null
  return (
    <Tabs
      value={activeResultId}
      onChange={(_event, id: string) => dispatch(ResultsActions.resultActivated(id))}
      variant="scrollable"
      scrollButtons="auto"
    >
      {tabs.map(tab => (
        <Tab
          key={tab.id}
          value={tab.id}
          data-testid={`result-tab-${tab.id}`}
          label={
            <ClosableTabLabel
              title={ResultTabsBar.titleOf(tab)}
              closeLabel={`Close ${tab.title}`}
              onClose={() => dispatch(ResultsActions.resultClosed(tab.id))}
              actions={[
                {
                  label: `${tab.pinned ? "Unpin" : "Pin"} ${tab.title}`,
                  icon: tab.pinned ? <PushPinIcon fontSize="inherit" /> : <PushPinOutlinedIcon fontSize="inherit" />,
                  onAction: () => dispatch(ResultsActions.pinToggled(tab.id))
                }
              ]}
            />
          }
        />
      ))}
    </Tabs>
  )
}

/** Result-tab texts. */
export namespace ResultTabsBar {
  /** Appended to the title of a running tab. */
  export const RunningSuffix = " …"

  /**
   * The label text of a tab.
   *
   * @param tab - The result tab.
   * @returns Its title, marked while running.
   */
  export function titleOf(tab: ResultTab): string {
    return tab.status === ResultTabStatus.running ? `${tab.title}${RunningSuffix}` : tab.title
  }
}
