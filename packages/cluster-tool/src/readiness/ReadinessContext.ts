import { APIClient, contracts } from "@wireio/sdk-core"
import {
  type ClusterReadinessCheck,
  ClusterReadinessCheckStatus,
  ClusterReadinessEndpointKind,
  type ClusterSwapRouteReadiness
} from "@wireio/cluster-tool-shared"
import { NestedError } from "@wireio/shared"

import type { Logger } from "../logging/Logger.js"
import { OrchestrationContext } from "../orchestration/OrchestrationContext.js"
import { Report } from "../report/Report.js"
import type { ReadinessConfig } from "./ReadinessConfig.js"
import { ReadinessOutputs } from "./ReadinessOutputs.js"

interface JsonRpcError {
  code?: number
  message?: string
}

interface JsonRpcResponse<T> {
  result?: T
  error?: JsonRpcError
}

enum ReadinessPassOmittedField {
  status = "status",
  detail = "detail"
}

/** Connected, read-only context used by readiness Steps. */
export class ReadinessContext extends OrchestrationContext<ReadinessConfig> {
  readonly wireApi: APIClient
  readonly wireSystem: ReturnType<typeof contracts.sysio.createClient>

  /** Creates a connected readiness context without wallets or signers. */
  constructor(
    config: ReadinessConfig,
    log: Logger,
    readonly request: typeof fetch = globalThis.fetch
  ) {
    super(config, log)
    const wire = this.endpoint(ClusterReadinessEndpointKind.wire)
    this.wireApi = new APIClient({
      url: wire?.url ?? "http://127.0.0.1",
      fetch: request,
      timeoutMs: config.timeoutMs
    })
    this.wireSystem = contracts.sysio.createClient({ client: this.wireApi })
    this.outputs.set(ReadinessOutputs.checks, [])
    this.outputs.set(ReadinessOutputs.routes, [])
  }

  /** Return a selected endpoint by role. */
  endpoint(kind: ClusterReadinessEndpointKind) {
    return (
      this.config.endpoints.find(endpoint => endpoint.kind === kind) ?? null
    )
  }

  /** Append one readiness result and record its structured evidence on the Step. */
  recordCheck(check: ClusterReadinessCheck): void {
    this.outputs.set(ReadinessOutputs.checks, [
      ...this.outputs.assert(ReadinessOutputs.checks),
      check
    ])
    Report.StepExtraRecorder.note(check.detail, {
      readiness: check
    })
  }

  /** Append public route evidence. */
  recordRoutes(routes: ClusterSwapRouteReadiness[]): void {
    this.outputs.set(ReadinessOutputs.routes, [
      ...this.outputs.assert(ReadinessOutputs.routes),
      ...routes
    ])
  }

  /** Execute a JSON-RPC read against an arbitrary selected chain endpoint. */
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
    if (response.result == null) {
      throw new Error(`${method} returned no result`)
    }
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
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
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
}

/** Readiness assertion output returned by successful check operations. */
export interface ReadinessAssertion {
  detail: string
  evidence?: Record<string, unknown>
}

/** Error carrying a stable readiness reason and optional evidence. */
export class ReadinessAssertionError extends Error {
  constructor(
    message: string,
    readonly reason: ClusterReadinessCheck["reason"],
    readonly evidence?: Record<string, unknown>
  ) {
    super(message)
    this.name = "ReadinessAssertionError"
  }
}

/** Convert a successful assertion into a check result. */
export function readinessPass(
  check: Omit<ClusterReadinessCheck, `${ReadinessPassOmittedField}`>,
  assertion: ReadinessAssertion
): ClusterReadinessCheck {
  return {
    ...check,
    status: ClusterReadinessCheckStatus.pass,
    detail: assertion.detail,
    ...(assertion.evidence ? { evidence: assertion.evidence } : {})
  }
}
