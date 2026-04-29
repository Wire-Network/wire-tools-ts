import { DebuggingServerClient } from "@wireio/debugging-client-shared"
import { ApiPaths } from "@wireio/debugging-shared"

import { formatInspect, OutputFormat } from "../formatter.js"

export interface InspectArgs {
  server: string
  format: string
  key: string
}

export async function handleInspect(argv: InspectArgs): Promise<void> {
  const client = await DebuggingServerClient.create({ baseUrl: argv.server })
  const format =
    argv.format === OutputFormat.json ? OutputFormat.json : OutputFormat.plain

  const result = await client.call(ApiPaths.OPP.Methods.EnvelopeGet, {
    key: argv.key
  })

  console.log(formatInspect(result, format))
}
