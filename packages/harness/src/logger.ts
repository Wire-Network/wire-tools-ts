// import tracer from "tracer"
//
// export const log = tracer.colorConsole({
//   format: "{{timestamp}} [{{title}}] {{file}}:{{line}} — {{message}}",
//   dateformat: "HH:MM:ss.L",
//   level: process.env.LOG_LEVEL || "info"
// })

import { Console } from "node:console"

export const log = new Console(process.stdout, process.stderr)

export default log
