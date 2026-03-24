import tracer from "tracer"

export const log = tracer.colorConsole({
  format: "{{timestamp}} [{{title}}] {{file}}:{{line}} — {{message}}",
  dateformat: "HH:MM:ss.L",
  level: process.env.LOG_LEVEL || "info",
})
