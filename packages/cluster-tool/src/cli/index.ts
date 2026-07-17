import "source-map-support/register.js"
import Yargs from "yargs"
import { createCreateCommand } from "./CreateCommand.js"
import { createDestroyCommand } from "./DestroyCommand.js"
import { createRunCommand } from "./RunCommand.js"

/**
 * The `wire-cluster-tool` CLI: parser assembly only — each command's options
 * and handler are collocated in its own module ({@link createCreateCommand},
 * {@link createRunCommand}, {@link createDestroyCommand}) per STYLE.md's
 * "Framework-Native Dispatch"; yargs dispatches, this function does not.
 */
export function main(argv: string[] = process.argv.slice(2)): Promise<unknown> {
  return Yargs(argv.filter(arg => !arg.startsWith("--inspect")))
    .scriptName("wire-cluster-tool")
    .command(createCreateCommand())
    .command(createRunCommand())
    .command(createDestroyCommand())
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync()
}

void main()
