// import tracer from "tracer"
//
// export const log = tracer.colorConsole({
//   format: "{{timestamp}} [{{title}}] {{file}}:{{line}} — {{message}}",
//   dateformat: "HH:MM:ss.L",
//   level: process.env.LOG_LEVEL || "info"
// })

import { getLogger as getLoggerInternal, LoggingManager } from "@wireio/shared"

export const log = getLoggerInternal("global")

export function getLogger(category: string) {
  return getLoggerInternal(category, {})
}

export default log
