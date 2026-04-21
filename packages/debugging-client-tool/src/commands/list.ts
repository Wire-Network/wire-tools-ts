import { DebuggingServerClient } from "@wire-e2e-tests/debugging-client-shared"
import { ApiPaths } from "@wire-e2e-tests/debugging-shared"

import { formatList, OutputFormat } from "../formatter"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

export interface ListArgs {
  server: string
  format: string
  epoch?: number
  epochStart?: number
  epochEnd?: number
  endpoints?: string
  start?: string
  end?: string
}

export async function handleList(argv: ListArgs): Promise<void> {
  const client = await DebuggingServerClient.create({ baseUrl: argv.server })
  const format =
    argv.format === OutputFormat.json ? OutputFormat.json : OutputFormat.plain

  // Build filter params
  const epochStart = argv.epochStart ?? argv.epoch ?? 0
  const epochEnd = argv.epochEnd ?? argv.epoch ?? 0

  // Resolve endpoints filter
  let endpointsType = DebugOutpostEndpointsType.UNKNOWN
  if (argv.endpoints) {
    const upper = argv.endpoints.toUpperCase()
    const match = Object.entries(DebugOutpostEndpointsType).find(
      ([name]) => name.toUpperCase() === upper
    )
    if (match) {
      endpointsType = match[1] as DebugOutpostEndpointsType
    }
  }

  // Parse timestamp filters (ISO string or unix ms)
  const timestampStart = parseTimestamp(argv.start)
  const timestampEnd = parseTimestamp(argv.end)

  const result = await client.call(ApiPaths.OPP.Methods.EnvelopeList, {
    epochStart,
    epochEnd,
    endpointsType,
    timestampStart: BigInt(timestampStart),
    timestampEnd: BigInt(timestampEnd)
  })

  console.log(formatList(result.entries, format))

  if (format === OutputFormat.plain) {
    console.log(`\nTotal: ${result.total} envelope(s)`)
  }
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0
  const asNum = Number(value)
  if (!isNaN(asNum)) return asNum
  const asDate = new Date(value)
  if (!isNaN(asDate.getTime())) return asDate.getTime()
  return 0
}
