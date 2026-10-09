import { Either } from "@3fv/prelude-ts"
import { identity } from "lodash"
import type { Argv, CommandModule } from "yargs"

import type { ConnectionProfile } from "@wireio/ql-shared"

import { applyConnectionArgs, ConnectionArgs, type ConnectionOptions } from "../args/index.js"
import type { CliContext } from "../context/index.js"
import { QLUsageError } from "../exit/index.js"
import { OutputWriter } from "../output/index.js"
import { QLCli, type GlobalOptions } from "../QLCli.js"
import { requiredPositional, subcommandGroup } from "./commandUtils.js"
import { ProfilesSubcommand, QLCommand } from "./QLCommand.js"

/** Parsed flags of `wql profiles …`. */
export interface ProfilesCommandArgs extends GlobalOptions, ConnectionOptions {
  /** Profile name (add / remove / default). */
  name?: string
  /** Endpoint (add). */
  endpoint?: string
  /** `--default`: make the added profile the default. */
  default?: boolean
}

/** Marker of the default profile in listings. */
const DefaultMarker = "*"
/** Marker of a non-default profile (keeps columns aligned). */
const NonDefaultMarker = " "

/**
 * `wql profiles list|add|remove|default` — the saved connections shared by CLI, TUI and GUI.
 *
 * @param context - The run context.
 * @returns The yargs command module.
 */
export function createProfilesCommand(context: CliContext): CommandModule<object, ProfilesCommandArgs> {
  return subcommandGroup<ProfilesCommandArgs>(QLCommand.profiles, "manage saved connection profiles", yargs =>
    yargs
      .command(
        ProfilesSubcommand.list,
        "list saved profiles (* = default)",
        identity,
        QLCli.handle(context, async () => {
          const { defaultProfile, profiles } = context.profileStore.read()
          OutputWriter.writeLines(profiles.map(profile => ProfilesCommand.profileLine(profile, profile.name === defaultProfile)))
        })
      )
      .command(
        `${ProfilesSubcommand.add} <name> <endpoint>`,
        "add (or replace) a profile",
        (sub: Argv) =>
          applyConnectionArgs(requiredPositional(sub, "name", "endpoint")).option("default", {
            type: "boolean",
            describe: "make it the default profile"
          }),
        QLCli.handle(context, async (argv: ProfilesCommandArgs) => {
          const profile = ProfilesCommand.addProfile(context, argv)
          OutputWriter.writeLines([ProfilesCommand.savedText(profile.name)])
        })
      )
      .command(
        `${ProfilesSubcommand.remove} <name>`,
        "remove a profile",
        (sub: Argv) => requiredPositional(sub, "name"),
        QLCli.handle(context, async (argv: ProfilesCommandArgs) => {
          context.profileStore.remove(argv.name)
          OutputWriter.writeLines([ProfilesCommand.removedText(argv.name)])
        })
      )
      .command(
        `${ProfilesSubcommand.default} <name>`,
        "make a profile the default",
        (sub: Argv) => requiredPositional(sub, "name"),
        QLCli.handle(context, async (argv: ProfilesCommandArgs) => {
          context.profileStore.setDefault(argv.name)
          OutputWriter.writeLines([ProfilesCommand.defaultText(argv.name)])
        })
      )
  )
}

/** Profile command helpers. */
export namespace ProfilesCommand {
  /**
   * The confirmation of a saved profile (`wql profiles add`, the TUI's profile form).
   *
   * @param name - The profile's name.
   * @returns The line.
   */
  export function savedText(name: string): string {
    return `saved profile ${name}`
  }

  /**
   * The confirmation of a removed profile.
   *
   * @param name - The profile's name.
   * @returns The line.
   */
  export function removedText(name: string): string {
    return `removed profile ${name}`
  }

  /**
   * The confirmation of a new default profile.
   *
   * @param name - The profile's name.
   * @returns The line.
   */
  export function defaultText(name: string): string {
    return `default profile ${name}`
  }

  /**
   * One listing line: `<marker> name<TAB>endpoint`.
   *
   * @param profile - The profile.
   * @param isDefault - Whether it is the default.
   * @returns The line.
   */
  export function profileLine(profile: ConnectionProfile, isDefault: boolean): string {
    return `${isDefault ? DefaultMarker : NonDefaultMarker} ${profile.name}\t${profile.endpoint}`
  }

  /**
   * Validate + save the profile of `profiles add` (optionally as the default).
   *
   * @param context - The run context.
   * @param argv - The parsed flags.
   * @returns The saved profile.
   * @throws QLUsageError when the fields are invalid.
   */
  export function addProfile(context: CliContext, argv: ProfilesCommandArgs): ConnectionProfile {
    const { name, endpoint } = argv,
      profile = Either.try(() => context.profileStore.upsert({ name, endpoint, ...ConnectionArgs.profileOverrides(argv) }))
        .ifLeft(error => {
          throw new QLUsageError(`invalid profile ${name}`, { cause: error, context: { name, endpoint } })
        })
        .getOrThrow()
    if (argv.default === true) context.profileStore.setDefault(profile.name)
    return profile
  }
}
