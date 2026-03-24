import { APIClient } from "@wireio/sdk-core"
import { Clio, type ClioConfig } from "./clio.js"
import { log } from "../logger.js"

export interface WireClientConfig {
  /** nodeop HTTP URL */
  httpUrl: string
  /** Clio config for wallet/contract operations */
  clio: ClioConfig
}

/**
 * Client for interacting with a WIRE chain node.
 * Uses @wireio/sdk-core APIClient for chain queries and
 * clio CLI for wallet management and contract deployment.
 */
export class WireClient {
  public api: APIClient
  public clio: Clio

  constructor(public readonly config: WireClientConfig) {
    this.api = new APIClient({ url: config.httpUrl })
    this.clio = new Clio(config.clio)
  }

  /** GET /v1/chain/get_info via sdk-core */
  async getInfo(): Promise<any> {
    return this.api.v1.chain.get_info()
  }

  /** GET table rows via sdk-core */
  async getTableRows(params: {
    code: string
    scope: string
    table: string
    limit?: number
    lower_bound?: string
    upper_bound?: string
  }): Promise<any> {
    return this.api.v1.chain.get_table_rows({
      code: params.code,
      scope: params.scope,
      table: params.table,
      limit: params.limit || 100,
      lower_bound: params.lower_bound,
      upper_bound: params.upper_bound,
      json: true,
    })
  }

  /** Read epoch state from sysio.epoch contract */
  async getEpochState(): Promise<any> {
    return this.getTableRows({ code: "sysio.epoch", scope: "sysio.epoch", table: "epochstate" })
  }

  /** Read epoch config from sysio.epoch contract */
  async getEpochConfig(): Promise<any> {
    return this.getTableRows({ code: "sysio.epoch", scope: "sysio.epoch", table: "epochcfg" })
  }

  /** Read operator roster from sysio.epoch contract */
  async getOperators(): Promise<any> {
    return this.getTableRows({ code: "sysio.epoch", scope: "sysio.epoch", table: "operators" })
  }

  /** Read messages from sysio.msgch contract */
  async getMessages(): Promise<any> {
    return this.getTableRows({ code: "sysio.msgch", scope: "sysio.msgch", table: "messages" })
  }

  /** Read inbound chain requests from sysio.msgch */
  async getChainRequests(): Promise<any> {
    return this.getTableRows({ code: "sysio.msgch", scope: "sysio.msgch", table: "inchainreq" })
  }

  /** Read underwriting ledger from sysio.uwrit */
  async getUnderwritingLedger(): Promise<any> {
    return this.getTableRows({ code: "sysio.uwrit", scope: "sysio.uwrit", table: "uwledger" })
  }

  /** Read collateral from sysio.uwrit */
  async getCollateral(): Promise<any> {
    return this.getTableRows({ code: "sysio.uwrit", scope: "sysio.uwrit", table: "collateral" })
  }

  /** Read outpost registry from sysio.epoch */
  async getOutposts(): Promise<any> {
    return this.getTableRows({ code: "sysio.epoch", scope: "sysio.epoch", table: "outposts" })
  }
}
