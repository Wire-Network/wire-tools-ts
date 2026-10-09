import type { ParentPort } from "electron"
import { FileLogging, type FileLoggingInstallation } from "@wireio/ql-shared/node"
import { getLogger } from "@wireio/shared"

import { QueryHostArguments } from "../common/index.js"
import { QueryHost, QueryHostContext } from "./QueryHost.js"

const log = getLogger(__filename)

/** Query-host process constants. */
export namespace QueryHostProcess {
  /** Log file name inside the logs directory. */
  export const LogFilename = "query-host.log"

  /**
   * The logs directory from argv, if given.
   *
   * @param argv - Process arguments.
   * @returns The directory, or undefined.
   */
  export function logsPathOf(argv: readonly string[]): string {
    const index = argv.indexOf(QueryHostArguments.LogsPathFlag)
    return index >= 0 ? argv[index + 1] : undefined
  }

  /**
   * Route every logger of this process to `<logsPath>/query-host.log` at `LOG_LEVEL`.
   *
   * @param logsPath - The logs directory.
   * @returns The installation.
   */
  export function installFileLogging(logsPath: string): FileLoggingInstallation {
    return FileLogging.install({ logsPath, filename: LogFilename })
  }
}

/**
 * Start serving query ports over `parentPort` (file logging first when the logs
 * directory was passed).
 *
 * @param parentPort - The utility process's channel to main.
 * @param argv - Process arguments.
 * @returns The running host.
 */
export function startQueryHost(parentPort: ParentPort, argv: readonly string[] = process.argv): QueryHost {
  const logsPath = QueryHostProcess.logsPathOf(argv)
  if (logsPath != null) QueryHostProcess.installFileLogging(logsPath)
  const host = new QueryHost(parentPort, new QueryHostContext())
  log.info(`query host started (pid ${process.pid})`)
  return host
}

// Self-start ONLY inside an Electron utility process — plain Node can require this
// module (the bundle smoke test) without side effects.
if (process.parentPort != null) startQueryHost(process.parentPort)
