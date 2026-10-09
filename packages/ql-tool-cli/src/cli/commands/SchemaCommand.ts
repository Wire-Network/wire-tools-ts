import { Either } from "@3fv/prelude-ts"
import { identity } from "lodash"
import type { Argv, CommandModule } from "yargs"

import { CatalogSnapshot, ConnectionProfile, type CatalogField, type CatalogTable } from "@wireio/ql-shared"

import { ListingEmptyCell, listingLine } from "../../utils/index.js"
import { applyConnectionArgs, type ConnectionOptions } from "../args/index.js"
import type { CliContext } from "../context/index.js"
import { QLUsageError } from "../exit/index.js"
import { OutputWriter } from "../output/index.js"
import { QLCli, type GlobalOptions } from "../QLCli.js"
import { requiredPositional, subcommandGroup } from "./commandUtils.js"
import { QLCommand, SchemaSubcommand } from "./QLCommand.js"

/** Parsed flags of `wql schema …`. */
export interface SchemaCommandArgs extends GlobalOptions, ConnectionOptions {
  /** Owner account (tables / fields / describe). */
  owner?: string
  /** Table name (fields / describe). */
  table?: string
}

/**
 * `wql schema owners|tables|fields|describe` — browse the catalog (`get_abi` +
 * `LIMIT 0` describe).
 *
 * @param context - The run context.
 * @returns The yargs command module.
 */
export function createSchemaCommand(context: CliContext): CommandModule<object, SchemaCommandArgs> {
  return subcommandGroup<SchemaCommandArgs>(QLCommand.schema, "browse owners, tables and fields", yargs =>
    applyConnectionArgs(yargs)
      .command(
        SchemaSubcommand.owners,
        "list the owner accounts the catalog browses",
        identity,
        QLCli.handle(context, async (argv: SchemaCommandArgs) =>
          OutputWriter.writeLines(ConnectionProfile.resolveOwners(context.resolveProfile(argv)))
        )
      )
      .command(
        `${SchemaSubcommand.tables} <owner>`,
        "list the tables of an owner (from its ABI)",
        (sub: Argv) => requiredPositional(sub, "owner"),
        QLCli.handle(context, async (argv: SchemaCommandArgs) => {
          const snapshot = await context.createCatalog(context.resolveProfile(argv)).loadOwner(argv.owner)
          OutputWriter.writeLines(
            SchemaCommand.assertInCatalog(() => CatalogSnapshot.findOwner(snapshot, argv.owner)).tables.map(table =>
              SchemaCommand.tableLine(table)
            )
          )
        })
      )
      .command(
        `${SchemaSubcommand.fields} <owner> <table>`,
        "list a table's key and value fields with their ABI types",
        (sub: Argv) => requiredPositional(sub, "owner", "table"),
        QLCli.handle(context, async (argv: SchemaCommandArgs) => {
          const snapshot = await context.createCatalog(context.resolveProfile(argv)).loadOwner(argv.owner)
          OutputWriter.writeLines(SchemaCommand.tableFieldLines(snapshot, argv))
        })
      )
      .command(
        `${SchemaSubcommand.describe} <owner> <table>`,
        "describe a table: fields with engine logical types (LIMIT 0 probe)",
        (sub: Argv) => requiredPositional(sub, "owner", "table"),
        QLCli.handle(context, async (argv: SchemaCommandArgs) => {
          const snapshot = await context.createCatalog(context.resolveProfile(argv)).describe(argv.owner, argv.table)
          OutputWriter.writeLines(SchemaCommand.tableFieldLines(snapshot, argv))
        })
      )
  )
}

/** Listing lines of the schema subcommands. */
export namespace SchemaCommand {
  /** Hint of an owner / table missing from the catalog. */
  export const NotInCatalogHint = "list them with `wql schema owners` / `wql schema tables <owner>`"

  /**
   * One table line: `name<TAB>rowType`.
   *
   * @param table - The catalog table.
   * @returns The line.
   */
  export function tableLine(table: CatalogTable): string {
    return listingLine([table.name, table.rowType])
  }

  /**
   * One field line: `path<TAB>role<TAB>abiType<TAB>logicalType|-`.
   *
   * @param field - The catalog field.
   * @returns The line.
   */
  export function fieldLine(field: CatalogField): string {
    return listingLine([field.path, field.role, field.abiType, field.logicalType ?? ListingEmptyCell])
  }

  /**
   * The field lines of the `--owner` / `--table` the user named.
   *
   * @param snapshot - The loaded catalog.
   * @param argv - The owner and table.
   * @returns The lines.
   * @throws QLUsageError when the table is not in the catalog.
   */
  export function tableFieldLines(snapshot: CatalogSnapshot, argv: SchemaCommandArgs): string[] {
    return assertInCatalog(() => CatalogSnapshot.findTable(snapshot, argv.owner, argv.table)).fields.map(field =>
      fieldLine(field)
    )
  }

  /**
   * Look up a user-named owner / table: a miss is a usage problem (the user names
   * another), not an operational failure.
   *
   * @param lookup - The catalog lookup.
   * @returns What it found.
   * @throws QLUsageError wrapping the lookup's error.
   */
  export function assertInCatalog<T>(lookup: () => T): T {
    return Either.try(lookup)
      .ifLeft(error => {
        throw new QLUsageError(`${error.message}; ${NotInCatalogHint}`, { cause: error })
      })
      .getOrThrow()
  }
}
