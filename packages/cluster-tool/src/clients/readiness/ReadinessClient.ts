import { APIClient, contracts } from "@wireio/sdk-core"
import { NestedError } from "@wireio/shared"

import type { ReadinessConfig } from "../../config/ReadinessConfig.js"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { readinessEndpointLabel } from "../../utils/readinessUtils.js"
import { RecordingFetchProvider } from "../wire/RecordingFetchProvider.js"

const log = getLogger(__filename)

interface JsonRpcError {
  code?: number
  message?: string
}

interface JsonRpcResponse<T> {
  result?: T
  error?: JsonRpcError
}

/** Read-only chain clients shared by connected and freshly bootstrapped readiness runs. */
export class ReadinessClient {
  /** Resolved endpoints and timing limits used by every request. */
  readonly config: ReadinessConfig
  /** Fetch implementation shared by WIRE and generic JSON-RPC reads. */
  readonly request: typeof fetch
  /** WIRE API client whose calls are captured in the current report Step. */
  readonly wireApi: APIClient
  /** Typed WIRE system-contract table clients backed by {@link wireApi}. */
  readonly wireSystem: ReturnType<typeof contracts.sysio.createClient>

  /**
   * Create read-only clients without wallets or signing authority.
   *
   * @param config - Resolved endpoints and request timeout.
   * @param request - Fetch implementation used by all HTTP clients.
   */
  constructor(
    config: ReadinessConfig,
    request: typeof fetch = globalThis.fetch
  ) {
    this.config = config
    this.request = request
    this.wireApi = new APIClient({
      provider: new RecordingFetchProvider(config.endpoints.wireRpc, {
        fetch: request,
        timeoutMs: config.timeoutMs
      })
    })
    this.wireSystem = contracts.sysio.createClient({ client: this.wireApi })
  }

  /**
   * Execute a timeout-bounded JSON-RPC read.
   *
   * @param url - JSON-RPC endpoint URL.
   * @param method - JSON-RPC method name.
   * @param params - JSON-RPC positional parameters.
   * @returns The decoded JSON-RPC result.
   */
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

  /**
   * Execute one timeout-bounded JSON HTTP request.
   *
   * @param url - HTTP endpoint URL.
   * @param init - Fetch request options.
   * @returns The decoded JSON response body.
   */
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
      const label = readinessEndpointLabel(url),
        cause = createRedactedRequestError(error, url, label)
      log.error(`Request failed: ${label}: ${cause.message}`)
      throw new NestedError(`Request failed: ${label}`, {
        cause,
        context: { method: init.method ?? "GET" }
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Record human-readable, JSON-safe evidence on the running report Step.
   *
   * @param detail - Concise assertion outcome.
   * @param evidence - Structured supporting evidence.
   * @returns Nothing.
   */
  recordEvidence(detail: string, evidence: Record<string, unknown> = {}): void {
    Report.StepExtraRecorder.note(detail, { readiness: evidence })
  }
}

function createRedactedRequestError(
  error: unknown,
  endpoint: string,
  label: string
): Error {
  const url = new URL(endpoint),
    message = error instanceof Error ? error.message : String(error),
    secrets = [endpoint, url.username, url.password, url.search, url.hash]
      .filter(secret => secret.length > 0)
      .sort((left, right) => right.length - left.length),
    redacted = secrets.reduce(
      (value, secret) => value.replaceAll(secret, "[redacted]"),
      message.replaceAll(endpoint, label)
    )
  return new Error(redacted)
}
