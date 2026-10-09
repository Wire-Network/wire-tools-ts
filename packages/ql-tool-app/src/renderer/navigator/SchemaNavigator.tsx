import Box from "@mui/material/Box"
import CircularProgress from "@mui/material/CircularProgress"
import Typography from "@mui/material/Typography"
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView"
import { TreeItem } from "@mui/x-tree-view/TreeItem"
import { match } from "ts-pattern"

import { CatalogFieldRole, CatalogSnapshot, QueryText, type CatalogTable } from "@wireio/ql-shared"

import { ActionRegistry, AppAction } from "../../common/index.js"
import { Clipboard, DisplayText } from "../common/index.js"
import {
  describeTable,
  loadOwner,
  openAndRunQuery,
  showContextMenu,
  UiActions,
  useAppDispatch,
  useAppSelector
} from "../store/index.js"

/**
 * The schema navigator: owners → tables → key/value fields (ABI + logical types
 * from the catalog snapshot). Expanding an owner loads its ABI; expanding a table
 * describes it. Context menu ({@link SchemaNavigator.TableMenuActions}): Select
 * rows, Describe, Copy qualified name, Reload owner.
 *
 * @returns The navigator.
 */
export function SchemaNavigator() {
  const dispatch = useAppDispatch(),
    { snapshot, loadingOwners, error } = useAppSelector(state => state.catalog)
  if (snapshot == null) {
    return (
      <Typography sx={{ p: 2 }} color="text.secondary">
        Add a connection to browse the schema.
      </Typography>
    )
  }

  const onExpanded = (itemIds: string[]) =>
    itemIds.forEach(itemId => {
      if (itemId.startsWith(SchemaNavigator.OwnerPrefix)) {
        const owner = itemId.slice(SchemaNavigator.OwnerPrefix.length),
          entry = snapshot.owners.find(candidate => candidate.account === owner)
        if (entry != null && !entry.loaded && !loadingOwners.includes(owner)) void dispatch(loadOwner(owner))
      } else if (itemId.startsWith(SchemaNavigator.TablePrefix)) {
        const [owner, table] = itemId.slice(SchemaNavigator.TablePrefix.length).split(SchemaNavigator.TableSeparator),
          entry = CatalogSnapshot.lookupTable(snapshot, owner, table)
        if (entry != null && !entry.described) void dispatch(describeTable(owner, table))
      }
    })

  const onTableMenu = async (owner: string, table: string) => {
    const action = await dispatch(showContextMenu(...SchemaNavigator.TableMenuActions))
    match(action)
      .with(AppAction.selectRows, () => void dispatch(openAndRunQuery({ text: SchemaNavigator.selectRowsQuery(owner, table) })))
      .with(AppAction.describeTable, () => void dispatch(describeTable(owner, table)))
      .with(AppAction.copyQualifiedName, () => {
        const name = QueryText.qualifyTable(owner, table)
        void Clipboard.copy(name).then(copied => copied && dispatch(UiActions.noticeChanged(`Copied ${name}`)))
      })
      .with(AppAction.reloadOwner, () => void dispatch(loadOwner(owner)))
      .otherwise(() => undefined)
  }

  return (
    <Box sx={{ height: "100%", overflow: "auto" }} data-testid="schema-navigator">
      {error != null && (
        <Typography variant="caption" color="error" sx={{ px: 1 }}>
          {error}
        </Typography>
      )}
      <SimpleTreeView onExpandedItemsChange={(_event, itemIds) => onExpanded(itemIds)}>
        {snapshot.owners.map(owner => (
          <TreeItem
            key={owner.account}
            itemId={`${SchemaNavigator.OwnerPrefix}${owner.account}`}
            label={
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                {owner.account}
                {loadingOwners.includes(owner.account) && <CircularProgress size={10} />}
              </Box>
            }
          >
            {owner.loaded ? (
              owner.tables.map(table => (
                <TreeItem
                  key={table.name}
                  itemId={`${SchemaNavigator.TablePrefix}${owner.account}${SchemaNavigator.TableSeparator}${table.name}`}
                  label={table.name}
                  onContextMenu={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    void onTableMenu(owner.account, table.name)
                  }}
                >
                  {table.fields.map((field, index) => (
                    <TreeItem
                      key={field.path}
                      itemId={`${SchemaNavigator.FieldPrefix}${owner.account}.${table.name}.${field.path}`}
                      label={SchemaNavigator.fieldLabel(table, index)}
                    />
                  ))}
                </TreeItem>
              ))
            ) : (
              <TreeItem itemId={`${SchemaNavigator.OwnerPrefix}${owner.account}:placeholder`} label="…" />
            )}
          </TreeItem>
        ))}
      </SimpleTreeView>
    </Box>
  )
}

/** Tree item ids encode the node (owner / table). */
export namespace SchemaNavigator {
  /** Owner node id prefix. */
  export const OwnerPrefix = "owner:"
  /** Table node id prefix. */
  export const TablePrefix = "table:"
  /** Field node id prefix. */
  export const FieldPrefix = "field:"
  /** Separator of owner and table in table ids. */
  export const TableSeparator = "/"
  /** A table node's context menu, in display order. */
  export const TableMenuActions = [
    AppAction.selectRows,
    AppAction.describeTable,
    AppAction.copyQualifiedName,
    AppAction.reloadOwner
  ] as const

  /**
   * The SQL of "Select Rows" (`ActionRegistry.SelectRowsLimit` rows, as its label says).
   *
   * @param owner - Owner account.
   * @param table - Table name.
   * @returns The query.
   */
  export function selectRowsQuery(owner: string, table: string): string {
    return `${QueryText.selectAllQuery(owner, table)} LIMIT ${ActionRegistry.SelectRowsLimit}`
  }

  /** Suffix marking a key field. */
  export const KeySuffix = " (key)"

  /**
   * One field's label (`path : abi[ · logical][ (key)]`).
   *
   * @param table - The table.
   * @param index - Field index.
   * @returns The label.
   */
  export function fieldLabel(table: CatalogTable, index: number): string {
    const field = table.fields[index]
    return `${field.path} : ${DisplayText.fieldType(field)}${field.role === CatalogFieldRole.key ? KeySuffix : ""}`
  }
}
