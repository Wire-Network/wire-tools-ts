import { APIClient } from "@wireio/sdk-core"
import {
  type ClusterReadinessEndpoint,
  ClusterReadinessEndpointKind,
  ClusterReadinessEndpointSource,
  ClusterReadinessFeature
} from "@wireio/cluster-tool-shared"
import { getLogger, NestedError } from "@wireio/shared"
import { match } from "ts-pattern"

import { ReadinessConfig, type ReadinessOptions } from "./ReadinessConfig.js"

const log = getLogger(__filename)

interface CatalogEndpointRecord {
  id?: number
  name?: string
  rpcUrl?: string
  networkType?: string
  chainId?: string
  wireChain?: string
  chainCode?: string
  isActive?: boolean
  priority?: number
}

interface CatalogEndpointResponse {
  endpoints?: CatalogEndpointRecord[]
}

interface CatalogDiscovery {
  records: CatalogEndpointRecord[]
  errors: string[]
}

interface CatalogCapture {
  records: CatalogEndpointRecord[]
  error: string | null
}

interface WireIdentityObservation {
  chainId: string | null
  error: string | null
}

enum CatalogNetworkType {
  eth = "eth",
  sol = "sol"
}

/** Resolve CLI inputs and endpoint-catalog records into a readiness config. */
export async function resolveReadinessConfig(
  options: ReadinessOptions,
  request: typeof fetch = globalThis.fetch
): Promise<ReadinessConfig> {
  if (
    !options.wireChainId &&
    !options.wireRpc &&
    !options.outpostDeploymentProfile
  ) {
    throw new Error(
      "Provide wireChainId, wireRpc, or an outpostDeploymentProfile"
    )
  }

  const explicitWireChainId = normalizedWireChainId(options.wireChainId),
    profileWireChainId = normalizedWireChainId(
      options.outpostDeploymentProfile?.wire.chainId
    )
  if (
    explicitWireChainId &&
    profileWireChainId &&
    explicitWireChainId !== profileWireChainId
  ) {
    throw new Error(
      `wireChainId ${explicitWireChainId} does not match deployment profile ${profileWireChainId}`
    )
  }

  const timeoutMs = positiveInteger(
      options.timeoutMs,
      ReadinessConfig.DefaultTimeoutMs,
      "timeoutMs"
    ),
    requestedWireChainId = explicitWireChainId ?? profileWireChainId,
    explicitWireRpc = optionalUrl(options.wireRpc, "wireRpc"),
    observation =
      !requestedWireChainId && explicitWireRpc
        ? await observeWireChainId(explicitWireRpc, request, timeoutMs)
        : { chainId: null, error: null },
    discoveryChainId = requestedWireChainId ?? observation.chainId,
    catalogUrl = normalizedUrl(
      options.catalogUrl ?? ReadinessConfig.DefaultCatalogUrl,
      "catalogUrl"
    ),
    catalog = await discoverCatalog(
      catalogUrl,
      discoveryChainId,
      request,
      timeoutMs
    )

  return {
    feature: options.feature ?? ClusterReadinessFeature.swap,
    catalogUrl,
    requestedWireChainId,
    outpostDeploymentProfile: options.outpostDeploymentProfile,
    endpoints: selectEndpoints(options, catalog.records),
    catalogRecordCount: catalog.records.length,
    catalogErrors: [
      ...(observation.error ? [observation.error] : []),
      ...catalog.errors
    ],
    observationMs: positiveInteger(
      options.observationMs,
      ReadinessConfig.DefaultObservationMs,
      "observationMs"
    ),
    timeoutMs,
    report: options.report
  }
}

async function observeWireChainId(
  wireRpc: string,
  request: typeof fetch,
  timeoutMs: number
): Promise<WireIdentityObservation> {
  try {
    const info = await new APIClient({
      url: wireRpc,
      fetch: request,
      timeoutMs
    }).v1.chain.get_info()
    return { chainId: info.chain_id.toString().toLowerCase(), error: null }
  } catch (error: unknown) {
    log.warn(
      `Wire chain-id discovery failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return {
      chainId: null,
      error: `Wire chain-id discovery failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

async function discoverCatalog(
  catalogUrl: string,
  wireChainId: string | null,
  request: typeof fetch,
  timeoutMs: number
): Promise<CatalogDiscovery> {
  if (!wireChainId) {
    return {
      records: [],
      errors: [
        "Wire chain id was unavailable, so endpoint-catalog discovery could not run"
      ]
    }
  }

  const captures = await Promise.all([
      captureCatalog(() =>
        getCatalogRecords(
          catalogUrl,
          "chainId",
          wireChainId,
          request,
          timeoutMs
        )
      ),
      captureCatalog(() =>
        getCatalogRecords(
          catalogUrl,
          "wireChain",
          wireChainId,
          request,
          timeoutMs
        )
      )
    ]),
    errors = captures.flatMap(capture =>
      capture.error ? [capture.error] : []
    ),
    records = captures
      .flatMap(capture => capture.records)
      .filter(record => record.isActive !== false)
      .filter((record, index, all) => {
        const key = catalogRecordKey(record)
        return (
          all.findIndex(candidate => catalogRecordKey(candidate) === key) ===
          index
        )
      })

  return { records, errors }
}

async function captureCatalog(
  operation: () => Promise<CatalogEndpointRecord[]>
): Promise<CatalogCapture> {
  try {
    return { records: await operation(), error: null }
  } catch (error: unknown) {
    log.warn(
      `Endpoint-catalog discovery failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return {
      records: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function getCatalogRecords(
  catalogUrl: string,
  filterName: string,
  filterValue: string,
  request: typeof fetch,
  timeoutMs: number
): Promise<CatalogEndpointRecord[]> {
  const url = new URL(catalogUrl)
  url.searchParams.set(filterName, filterValue)
  url.searchParams.set("activeOnly", "true")
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await request(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(
        `Endpoint catalog returned ${response.status} ${response.statusText}`
      )
    }
    const body = (await response.json()) as
      CatalogEndpointResponse | CatalogEndpointRecord[]
    if (Array.isArray(body)) return body
    const { endpoints = [] } = body
    return endpoints
  } finally {
    clearTimeout(timeout)
  }
}

function selectEndpoints(
  options: ReadinessOptions,
  records: CatalogEndpointRecord[]
): ClusterReadinessEndpoint[] {
  const ordered = [...records].sort(
    (left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0)
  )
  return [
    selectEndpoint(
      ClusterReadinessEndpointKind.wire,
      optionalUrl(options.wireRpc, "wireRpc"),
      ordered
    ),
    selectEndpoint(
      ClusterReadinessEndpointKind.hyperion,
      optionalUrl(options.hyperionUrl, "hyperionUrl"),
      ordered
    ),
    selectEndpoint(
      ClusterReadinessEndpointKind.ethereum,
      optionalUrl(options.ethereumRpc, "ethereumRpc"),
      ordered
    ),
    selectEndpoint(
      ClusterReadinessEndpointKind.solana,
      optionalUrl(options.solanaRpc, "solanaRpc"),
      ordered
    )
  ].filter((endpoint): endpoint is ClusterReadinessEndpoint => endpoint != null)
}

function selectEndpoint(
  kind: ClusterReadinessEndpointKind,
  explicitUrl: string,
  records: CatalogEndpointRecord[]
): ClusterReadinessEndpoint {
  const metadata =
    records.find(
      record =>
        endpointKind(record.networkType) === kind &&
        explicitUrl != null &&
        comparableUrl(record.rpcUrl) === comparableUrl(explicitUrl)
    ) ?? records.find(record => endpointKind(record.networkType) === kind)

  if (explicitUrl) {
    return endpointFrom(
      kind,
      explicitUrl,
      ClusterReadinessEndpointSource.explicit,
      metadata
    )
  }
  return metadata?.rpcUrl
    ? endpointFrom(
        kind,
        normalizedUrl(metadata.rpcUrl, `${kind} catalog endpoint`),
        ClusterReadinessEndpointSource.catalog,
        metadata
      )
    : null
}

function endpointFrom(
  kind: ClusterReadinessEndpointKind,
  url: string,
  source: ClusterReadinessEndpointSource,
  metadata?: CatalogEndpointRecord
): ClusterReadinessEndpoint {
  return {
    kind,
    url,
    source,
    ...(metadata?.name ? { name: metadata.name } : {}),
    ...(metadata?.chainId ? { expectedChainId: metadata.chainId } : {}),
    ...(metadata?.chainCode
      ? { chainCode: metadata.chainCode.trim().toUpperCase() }
      : {})
  }
}

function endpointKind(value?: string): ClusterReadinessEndpointKind {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
  return match(normalized)
    .with(
      ClusterReadinessEndpointKind.wire,
      () => ClusterReadinessEndpointKind.wire
    )
    .with(
      ClusterReadinessEndpointKind.hyperion,
      () => ClusterReadinessEndpointKind.hyperion
    )
    .with(CatalogNetworkType.eth, () => ClusterReadinessEndpointKind.ethereum)
    .with(CatalogNetworkType.sol, () => ClusterReadinessEndpointKind.solana)
    .otherwise(() => null)
}

function normalizedWireChainId(value?: string): string {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (!ReadinessConfig.WireChainIdPattern.test(normalized)) {
    throw new Error("wireChainId must be exactly 64 hexadecimal characters")
  }
  return normalized
}

function optionalUrl(value: string | undefined, label: string): string {
  return value ? normalizedUrl(value, label) : null
}

function normalizedUrl(value: string, label: string): string {
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol")
    }
    return parsed.toString().replace(/\/$/, "")
  } catch (error: unknown) {
    throw new NestedError(`${label} must be an absolute HTTP(S) URL`, {
      cause: error,
      context: { value }
    })
  }
}

function comparableUrl(value?: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\/$/, "")
    .toLowerCase()
}

function catalogRecordKey(record: CatalogEndpointRecord): string | number {
  const { id = `${record.networkType}:${record.rpcUrl}` } = record
  return id
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return selected
}
