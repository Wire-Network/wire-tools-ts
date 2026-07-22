import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { DebuggingServer } from "@wireio/debugging-server"
import {
  ApiPaths,
  ClusterFiles,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import {
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"

/** Endpoint used by route publication fixtures unless a test overrides it. */
export const RouteTestEndpoint =
  DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT

/** JSON-RPC error object returned by the live Express transport. */
export interface JsonRpcErrorBody {
  /** Stable JSON-RPC error code. */
  readonly code: number
  /** Public error message. */
  readonly message: string
}

/** JSON-RPC response body returned by the live Express transport. */
export interface JsonRpcBody<Result> {
  /** JSON-RPC protocol version. */
  readonly jsonrpc?: string
  /** Successful method result. */
  readonly result?: Result
  /** Failed method result. */
  readonly error?: JsonRpcErrorBody
  /** Request identifier echoed by the server. */
  readonly id?: number | null
}

/** HTTP status, parsed JSON-RPC body, and originating request identifier. */
export interface JsonRpcCall<Result> {
  /** HTTP response status. */
  readonly status: number
  /** Parsed JSON-RPC response. */
  readonly body: JsonRpcBody<Result>
  /** Identifier sent with the request. */
  readonly id: number
}

/** JSON-compatible parameters accepted by the generated envelope request. */
export interface EnvelopePutParams {
  /** Batch operator name merged into metadata. */
  readonly batchOpName: string
  /** Generated endpoint enum value. */
  readonly endpointsType: DebugOutpostEndpointsType
  /** Protobuf envelope bytes encoded for protobuf JSON. */
  readonly envelopeData: string
}

/**
 * Live isolated debugging-server harness for OPP JSON-RPC route tests.
 */
export class EnvelopeRouteHarness {
  private nextId = 1

  private constructor(
    /** Isolated cluster root removed by {@link stop}. */
    readonly clusterPath: string,
    /** Canonical OPP storage directory beneath the cluster root. */
    readonly storageDir: string,
    /** Base URL bound to an ephemeral loopback port. */
    readonly baseUrl: string,
    private readonly server: DebuggingServer
  ) {}

  /**
   * Start an isolated server on an ephemeral port.
   * @param prefix Temporary-directory prefix identifying the suite.
   * @return Ready route harness.
   */
  static async start(prefix: string): Promise<EnvelopeRouteHarness> {
    const clusterPath = Fs.mkdtempSync(Path.join(OS.tmpdir(), `${prefix}-`))
    Fs.writeFileSync(
      Path.join(clusterPath, ClusterFiles.ConfigFilename),
      JSON.stringify({ clusterPath })
    )
    const server = await DebuggingServer.create({ clusterPath, port: 0 }),
      address = await server.start()
    return new EnvelopeRouteHarness(
      clusterPath,
      oppDebuggingPath(clusterPath),
      `http://127.0.0.1:${address.port}`,
      server
    )
  }

  /**
   * Invoke one method through the live `POST /api/opp` JSON-RPC surface.
   * @param method Canonical JSON-RPC method name.
   * @param params JSON-compatible method parameters.
   * @return HTTP and JSON-RPC response details.
   */
  async rpc<Result>(
    method: string,
    params: object
  ): Promise<JsonRpcCall<Result>> {
    const id = this.nextId++,
      response = await fetch(`${this.baseUrl}${ApiPaths.OPP.Endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id })
      }),
      body: JsonRpcBody<Result> = await response.json()
    return { status: response.status, body, id }
  }

  /**
   * Stop the server and remove its isolated cluster root.
   */
  async stop(): Promise<void> {
    await this.server.stop()
    Fs.rmSync(this.clusterPath, { recursive: true, force: true })
  }
}

/**
 * Serialize a deterministic generated envelope fixture.
 * @param epochIndex Epoch encoded into the envelope.
 * @param marker Byte marker distinguishing same-epoch fixtures.
 * @return Generated protobuf bytes.
 */
export function makeRouteEnvelope(epochIndex: number, marker = 0): Uint8Array {
  return Envelope.toBinary(
    Envelope.create({
      epochIndex,
      epochTimestamp: BigInt(marker),
      envelopeHash: new Uint8Array(32).fill(marker),
      previousEnvelopeHash: new Uint8Array(32),
      messages: []
    })
  )
}

/**
 * Build protobuf-JSON parameters for one envelope publication.
 * @param envelopeData Exact generated envelope bytes.
 * @param batchOpName Operator name to merge.
 * @param endpointsType Endpoint direction encoded into the storage key.
 * @return JSON-compatible request parameters.
 */
export function routePutParams(
  envelopeData: Uint8Array,
  batchOpName: string,
  endpointsType = RouteTestEndpoint
): EnvelopePutParams {
  return {
    batchOpName,
    endpointsType,
    envelopeData: Buffer.from(envelopeData).toString("base64")
  }
}
