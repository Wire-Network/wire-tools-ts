import { DebuggingToolClient } from "@wire-e2e-tests/debugging-client-shared"
import { ApiPaths } from "@wire-e2e-tests/debugging-shared"

import { formatInspect, OutputFormat } from "../formatter"

export interface InspectArgs {
   server: string
   format: string
   key: string
}

export async function handleInspect(argv: InspectArgs): Promise<void> {
   const client = await DebuggingToolClient.create({ baseUrl: argv.server })
   const format = argv.format === OutputFormat.json ? OutputFormat.json : OutputFormat.plain

   const result = await client.call(ApiPaths.OPP.EnvelopeGet, {
      key: argv.key,
   })

   console.log(formatInspect(result, format))
}
