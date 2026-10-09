import { noop } from "lodash"
import type { Argv, CommandModule } from "yargs"

import type { QLCommand } from "./QLCommand.js"

/** The positional a subcommand group routes on. */
export const SubcommandPositional = "subcommand"

/**
 * A command that only groups subcommands (`wql history list|clear|rerun`): it
 * demands one subcommand and has no handler of its own.
 *
 * @param command - The group's command name.
 * @param describe - Help text.
 * @param register - Registers the subcommands (and any flags shared by them).
 * @returns The yargs command module.
 */
export function subcommandGroup<A>(command: QLCommand, describe: string, register: (yargs: Argv) => Argv): CommandModule<object, A> {
  return {
    command: `${command} <${SubcommandPositional}>`,
    describe,
    builder: (yargs: Argv) => register(yargs).demandCommand(1) as unknown as Argv<A>,
    handler: noop
  }
}

/**
 * Declare required string positionals (`<name>`, `<owner> <table>`).
 *
 * @param builder - The subcommand's builder.
 * @param names - The positionals, in order.
 * @returns The builder, its arguments typed with the positionals.
 */
export function requiredPositional<T, N extends string>(builder: Argv<T>, ...names: N[]): Argv<T & Record<N, string>> {
  // yargs types one positional per call; the fold of N calls is the record of all N.
  return names.reduce<Argv<T>>((current, name) => current.positional(name, { type: "string", demandOption: true }), builder) as Argv<
    T & Record<N, string>
  >
}
