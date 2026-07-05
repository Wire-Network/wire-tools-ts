import { ethers } from "ethers"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"

/**
 * An `ethers.JsonRpcProvider` that records every JSON-RPC send into the
 * running step's `Report.StepResult.extra` (via {@link StepExtraRecorder}).
 * Every signer, wallet, and contract bound to this provider funnels through
 * {@link send}, so instrumenting here captures the whole Ethereum surface the
 * harness (and the flows' contract views) drive, with zero changes outside
 * `clients/`.
 *
 * State-changing / admin methods (transaction submissions, anvil/hardhat
 * admin) record richly — decoded payload + outcome. Read-class methods
 * (`eth_call`, `eth_getBalance`, block/receipt polling, …) record
 * REQUEST-ONLY, so identical poll repeats collapse into one `count`ed entry
 * in the recorder instead of ballooning `extra`.
 */
export class RecordingJsonRpcProvider extends ethers.JsonRpcProvider {
  override async send(method: string, params: unknown[]): Promise<unknown> {
    if (!RecordingJsonRpcProvider.shouldRecord(method)) {
      StepExtraRecorder.record({ client: "ethereum", kind: "call", method, params })
      return super.send(method, params)
    }
    const call = RecordingJsonRpcProvider.toCall(method, params)
    try {
      const result = await super.send(method, params)
      StepExtraRecorder.record({ ...call, ok: true, result })
      return result
    } catch (error) {
      StepExtraRecorder.record({
        ...call,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
}

export namespace RecordingJsonRpcProvider {
  /**
   * State-changing / admin JSON-RPC methods recorded RICHLY (payload +
   * outcome). Everything else records request-only via the `call` kind.
   */
  export const RecordedMethodPattern =
    /^(eth_sendTransaction|eth_sendRawTransaction|evm_|anvil_|hardhat_)/

  /** True when `method` records richly (state-changing / admin RPC). */
  export function shouldRecord(method: string): boolean {
    return RecordedMethodPattern.test(method)
  }

  /**
   * The `extra` record for one RPC send. Raw transaction submissions are
   * additionally DECODED (to/value/data/nonce via `ethers.Transaction.from`)
   * so the record carries the actual payload, not just opaque hex.
   */
  export function toCall(
    method: string,
    params: unknown[]
  ): StepExtraRecorder.ClientCall {
    const call: StepExtraRecorder.ClientCall = {
      client: "ethereum",
      kind: "rpc",
      method,
      params
    }
    if (method === "eth_sendRawTransaction" && typeof params[0] === "string") {
      try {
        const transaction = ethers.Transaction.from(params[0])
        call.transaction = {
          from: transaction.from,
          to: transaction.to,
          nonce: transaction.nonce,
          value: transaction.value.toString(),
          data: transaction.data
        }
      } catch {
        // Undecodable raw payload — the raw hex in `params` still rides.
      }
    }
    return call
  }
}
