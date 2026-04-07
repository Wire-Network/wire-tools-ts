// import tracer from "tracer"
//
// export const log = tracer.colorConsole({
//   format: "{{timestamp}} [{{title}}] {{file}}:{{line}} — {{message}}",
//   dateformat: "HH:MM:ss.L",
//   level: process.env.LOG_LEVEL || "info"
// })

import { getLogger as getLoggerInternal, LoggingManager } from "@wireio/shared"
import { Console } from "node:console"

// const realConsole = new Console(process.stdout, process.stderr)
// realConsole.log("always prints, unbuffered")
// export const log = getLoggerInternal("global")

export const log = new Console(process.stdout, process.stderr)

// export function getLogger(category: string) {
//
//   return getLoggerInternal(category, {})
// }

export default log
