/** wql command names (identity enum; `$0` routes to `query`). */
export enum QLCommand {
  query = "query",
  tui = "tui",
  schema = "schema",
  profiles = "profiles",
  history = "history",
  saved = "saved"
}

/** `wql schema` subcommands. */
export enum SchemaSubcommand {
  owners = "owners",
  tables = "tables",
  fields = "fields",
  describe = "describe"
}

/** `wql profiles` subcommands. */
export enum ProfilesSubcommand {
  list = "list",
  add = "add",
  remove = "remove",
  default = "default"
}

/** `wql history` subcommands. */
export enum HistorySubcommand {
  list = "list",
  clear = "clear",
  rerun = "rerun"
}

/** `wql saved` subcommands. */
export enum SavedSubcommand {
  list = "list",
  save = "save",
  run = "run",
  remove = "remove"
}
