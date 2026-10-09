/** Schema navigator node kinds (TUI tree and GUI navigator). */
export enum CatalogNodeKind {
  owner = "owner",
  table = "table",
  field = "field"
}

/** Whether a field is part of the primary key or the row value. */
export enum CatalogFieldRole {
  key = "key",
  value = "value"
}
