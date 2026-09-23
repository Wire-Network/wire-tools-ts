import "source-map-support/register.js"
import Yargs from "yargs"
import { createCreateApiNodeCommand } from "./CreateApiNodeCommand.js"
import { createCreateCommand } from "./CreateCommand.js"
import { createCreateExternalConfigCommand } from "./CreateExternalConfigCommand.js"
import { createDestroyCommand } from "./DestroyCommand.js"
import { createPackageCommand } from "./PackageCommand.js"
import { createRunCommand } from "./RunCommand.js"
import { createReadinessCommand } from "./ReadinessCommand.js"

/**
 * The `wire-cluster-tool` CLI: parser assembly only — each command's options
 * and handler are collocated in its own module ({@link createCreateCommand},
 * {@link createRunCommand}, {@link createDestroyCommand}) per STYLE.md's
 * "Framework-Native Dispatch"; yargs dispatches, this function does not.
 */
export function main(argv: string[] = process.argv.slice(2)): Promise<unknown> {
  // `create` pre-scans this SAME filtered array for `--cluster-build-options-file`
  // (its document seeds every other flag's default, so it must be read before
  // yargs parses) — hence one binding, handed to both Yargs and the command.
  const commandLine = argv.filter(arg => !arg.startsWith("--inspect"))
  return Yargs(commandLine)
    .scriptName("wire-cluster-tool")
    .command(createCreateCommand(commandLine))
    .command(createRunCommand())
    .command(createDestroyCommand())
    .command(createPackageCommand())
    .command(createReadinessCommand())
    .command(createCreateExternalConfigCommand())
    .command(createCreateApiNodeCommand())
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync()
}

void main()
