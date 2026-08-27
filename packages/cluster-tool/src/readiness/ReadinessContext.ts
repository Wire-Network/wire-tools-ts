import { APIClient, contracts } from "@wireio/sdk-core"
import { NestedError } from "@wireio/shared"

import type { Logger } from "../logging/Logger.js"
import { OrchestrationContext } from "../orchestration/OrchestrationContext.js"
import { Report } from "../report/Report.js"
import type { ReadinessConfig } from "./ReadinessConfig.js"

interface JsonRpcError {
  code?: number
  message?: string
}

interface JsonRpcResponse<T> {
  result?: T
  error?: JsonRpcError
}

/** Read-only clients shared by connected and freshly bootstrapped readiness. */
export class ReadinessClient {
  readonly wireApi: APIClient
  readonly wireSystem: ReturnType<typeof contracts.sysio.createClient>

  /** Create clients with no wallets or signing authority. */
  constructor(
    readonly config: ReadinessConfig,
    readonly request: typeof fetch = globalThis.fetch
  ) {
    this.wireApi = new APIClient({
      url: config.endpoints.wireRpc,
      fetch: request,
      timeoutMs: config.timeoutMs
    })
    this.wireSystem = contracts.sysio.createClient({ client: this.wireApi })
  }

  /** Execute a timeout-bounded JSON-RPC read. */
  async jsonRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const response = await this.fetchJson<JsonRpcResponse<T>>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    })
    if (response.error) {
      throw new Error(
        `${method} failed: ${response.error.message ?? response.error.code ?? "unknown RPC error"}`
      )
    }
    if (response.result == null) throw new Error(`${method} returned no result`)
    return response.result
  }

  /** Execute one timeout-bounded JSON HTTP request. */
  async fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const response = await this.request(url, {
        ...init,
        signal: controller.signal
      })
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`)
      return (await response.json()) as T
    } catch (error: unknown) {
      throw new NestedError(`Request failed: ${url}`, {
        cause: error,
        context: { method: init.method ?? "GET" }
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Record human-readable, JSON-safe evidence on the running report Step. */
  recordEvidence(detail: string, evidence: Record<string, unknown> = {}): void {
    Report.StepExtraRecorder.note(detail, { readiness: evidence })
  }
}

/** Capability required by reusable readiness Steps and PhaseGroups. */
export interface ReadinessCapable {
  readonly readiness: ReadinessClient
}

/** Connected orchestration context used by the standalone readiness CLI. */
export class ConnectedReadinessContext
  extends OrchestrationContext<ReadinessConfig>
  implements ReadinessCapable
{
  readonly readiness: ReadinessClient

  /** Create a connected context around explicit endpoints. */
  constructor(
    config: ReadinessConfig,
    log: Logger,
    request: typeof fetch = globalThis.fetch
  ) {
    super(config, log)
    this.readiness = new ReadinessClient(config, request)
  }
}

/** Successful result returned by a readiness assertion. */
export interface ReadinessAssertion {
  detail: string
  evidence?: Record<string, unknown>
}

/** Failure that carries structured readiness evidence into the native Report. */
export class ReadinessAssertionError extends Error {
  constructor(
    message: string,
    readonly evidence: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "ReadinessAssertionError"
  }
}

/** Run one assertion and project its evidence onto the current native Step. */
export async function runReadinessAssertion<C extends ReadinessCapable>(
  context: C,
  operation: () => Promise<ReadinessAssertion>
): Promise<void> {
  try {
    const result = await operation()
    context.readiness.recordEvidence(result.detail, result.evidence)
  } catch (error: unknown) {
    if (error instanceof ReadinessAssertionError) {
      context.readiness.recordEvidence(error.message, error.evidence)
    }
    throw error
  }
}
