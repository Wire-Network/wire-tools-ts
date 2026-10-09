import { identity } from "lodash"
import Yargs, { type Argv } from "yargs"

import { QLCommand, requiredPositional, subcommandGroup, SubcommandPositional } from "@wireio/ql-tool-cli/cli/index.js"

/** Parsed flags of the test group. */
interface GroupArgs {
  /** The positional of the `show` subcommand. */
  name?: string
}

describe("commandUtils", () => {
  it("subcommandGroup routes `<group> <subcommand>` and has no handler of its own", async () => {
    const shown: string[] = [],
      group = subcommandGroup<GroupArgs>(QLCommand.saved, "group", yargs =>
        yargs.command("show <name>", "show", (sub: Argv) => requiredPositional(sub, "name"), argv => void shown.push(argv.name))
      )
    expect(group.command).toBe(`${QLCommand.saved} <${SubcommandPositional}>`)
    expect(group.describe).toBe("group")
    await Yargs(["saved", "show", "x"]).command(group).exitProcess(false).parseAsync()
    expect(shown).toEqual(["x"])
  })

  it("subcommandGroup demands a subcommand", async () => {
    const group = subcommandGroup<GroupArgs>(QLCommand.saved, "group", yargs => yargs.command("show", "show", identity, () => undefined)),
      parse = async () =>
        Yargs(["saved"])
          .command(group)
          .exitProcess(false)
          .fail((message, error) => {
            throw error ?? new Error(message)
          })
          .parseAsync()
    await expect(parse()).rejects.toThrow(/at least 1/)
  })

  it("requiredPositional declares each positional as a required string", async () => {
    const argv = await requiredPositional(Yargs(["a", "b"]).command("$0 <owner> <table>", "x"), "owner", "table").parseAsync()
    expect([argv.owner, argv.table]).toEqual(["a", "b"])
  })
})
