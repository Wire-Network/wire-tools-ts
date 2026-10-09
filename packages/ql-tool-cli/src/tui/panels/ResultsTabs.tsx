import { Box, Text } from "ink"
import { match } from "ts-pattern"

import { QueryExecutionStatus } from "@wireio/ql-shared"

import { ErrorPrinter } from "../../cli/index.js"
import { Panel, TabStrip, type TabStripItem } from "../components/index.js"
import { TuiColorRole, TuiPalette } from "../editor/index.js"
import { QueryRunStatus, ResultsTab, useAppSelector } from "../store/index.js"
import { FieldTypesPanel } from "./FieldTypesPanel.js"
import { MessagesPanel } from "./MessagesPanel.js"
import { RecordViewPanel } from "./RecordViewPanel.js"
import { ResultsGridPanel } from "./ResultsGridPanel.js"
import { ResultsJsonPanel } from "./ResultsJsonPanel.js"
import { StatePanel } from "./StatePanel.js"
import { StatsPanel } from "./StatsPanel.js"

/** Props of {@link ResultsTabs}. */
export interface ResultsTabsProps {
  /** Focused (grid cursor shown). */
  focused: boolean
  /** Visible content rows. */
  height: number
  /** Available width. */
  width: number
}

/**
 * The results area: tab strip + the active tab (Grid / JSON / Record / Field
 * Types / Stats / State / Messages). A failed run shows its error on every
 * tab but Messages.
 *
 * @param props - Focus and size.
 * @returns The panel element.
 */
export function ResultsTabs({ focused, height, width }: ResultsTabsProps) {
  const tab = useAppSelector(state => state.ui.tab),
    status = useAppSelector(state => state.results.status),
    execution = useAppSelector(state => state.results.execution)
  return (
    <Panel title={ResultsTabs.Title} focused={focused} flexGrow={1}>
      <TabStrip tabs={ResultsTabs.Tabs} active={tab} />
      <Box flexDirection="column" height={height + 1}>
        {status === QueryRunStatus.failed && tab !== ResultsTab.messages && execution?.status === QueryExecutionStatus.failure ? (
          ErrorPrinter.failureLines(execution.failure, execution.query).map((line, index) => (
            <Text key={index} color={TuiPalette[TuiColorRole.error]}>
              {line}
            </Text>
          ))
        ) : (
          ResultsTabs.body(tab, focused, height, width)
        )}
      </Box>
    </Panel>
  )
}

/** Results tab table. */
export namespace ResultsTabs {
  /** Panel title. */
  export const Title = "Results"
  /** Tabs in order (Alt+J / Alt+V jump to JSON / Record). */
  export const Tabs: readonly TabStripItem<ResultsTab>[] = [
    { key: ResultsTab.grid, label: "Grid" },
    { key: ResultsTab.json, label: "JSON" },
    { key: ResultsTab.record, label: "Record" },
    { key: ResultsTab.fieldTypes, label: "Field Types" },
    { key: ResultsTab.stats, label: "Stats" },
    { key: ResultsTab.state, label: "State" },
    { key: ResultsTab.messages, label: "Messages" }
  ] as const

  /**
   * The body of a tab.
   *
   * @param tab - The tab.
   * @param focused - Whether the results area is focused.
   * @param height - Visible rows.
   * @param width - Available width.
   * @returns The body element.
   */
  export function body(tab: ResultsTab, focused: boolean, height: number, width: number) {
    return match(tab)
      .with(ResultsTab.grid, () => <ResultsGridPanel focused={focused} height={height} width={width} />)
      .with(ResultsTab.json, () => <ResultsJsonPanel height={height} />)
      .with(ResultsTab.record, () => <RecordViewPanel />)
      .with(ResultsTab.fieldTypes, () => <FieldTypesPanel />)
      .with(ResultsTab.stats, () => <StatsPanel />)
      .with(ResultsTab.state, () => <StatePanel />)
      .with(ResultsTab.messages, () => <MessagesPanel height={height} />)
      .exhaustive()
  }
}
