import { DebuggingToolClient } from "@wire-e2e-tests/debugging-client-shared"
import { ApiPaths, DebugOutpostEndpointsType } from "@wire-e2e-tests/debugging-shared"
import type { EnvelopeListEntry } from "@wire-e2e-tests/debugging-shared"

import { formatList, OutputFormat } from "../formatter"

export interface TailArgs {
   server: string
   format: string
   pollMs: number
   endpoints?: string
}

export async function handleTail(argv: TailArgs): Promise<void> {
   const client = await DebuggingToolClient.create({ baseUrl: argv.server })
   const format = argv.format === OutputFormat.json ? OutputFormat.json : OutputFormat.plain

   // Resolve endpoints filter
   let endpointsType = DebugOutpostEndpointsType.UNKNOWN
   if (argv.endpoints) {
      const upper = argv.endpoints.toUpperCase()
      const match = Object.entries(DebugOutpostEndpointsType)
         .find(([name]) => name.toUpperCase() === upper)
      if (match) {
         endpointsType = match[1] as DebugOutpostEndpointsType
      }
   }

   // Track already-seen keys to only print new entries
   const seenKeys = new Set<string>()

   // Initial fetch — seed seenKeys with what's already there
   const initial = await client.call(ApiPaths.OPP.EnvelopeList, {
      epochStart: 0,
      epochEnd: 0,
      endpointsType,
      timestampStart: BigInt(0),
      timestampEnd: BigInt(0),
   })
   initial.entries.forEach(e => seenKeys.add(e.key))

   if (format === OutputFormat.plain) {
      console.log(`Watching for new envelopes (poll every ${argv.pollMs}ms, ${seenKeys.size} existing)...`)
      console.log("")
   }

   // Poll loop
   const shutdown = () => { process.exit(0) }
   process.on("SIGINT", shutdown)
   process.on("SIGTERM", shutdown)

   while (true) {
      await sleep(argv.pollMs)

      const result = await client.call(ApiPaths.OPP.EnvelopeList, {
         epochStart: 0,
         epochEnd: 0,
         endpointsType,
         timestampStart: BigInt(0),
         timestampEnd: BigInt(0),
      })

      const newEntries: EnvelopeListEntry[] = result.entries.filter(
         e => !seenKeys.has(e.key)
      )

      if (newEntries.length > 0) {
         newEntries.forEach(e => seenKeys.add(e.key))
         console.log(formatList(newEntries, format))
         if (format === OutputFormat.plain) {
            console.log("")
         }
      }
   }
}

function sleep(ms: number): Promise<void> {
   return new Promise(resolve => setTimeout(resolve, ms))
}
