import { APIClient, SystemContracts } from "@wireio/sdk-core"

import { Clio, type ClioConfig } from "./Clio.js"
import { log } from "../logger.js"
import {
  GetTableRowsResponse,
  TableIndexType
} from "@wireio/sdk-core/api/v1/Types"

export interface WIREChainInfo {
  server_version: string
  chain_id: string
  head_block_num: number
  last_irreversible_block_num: number
  last_irreversible_block_id: string
  head_block_id: string
  head_block_time: string
  head_block_producer: string
  virtual_block_cpu_limit: number
  virtual_block_net_limit: number
  block_cpu_limit: number
  block_net_limit: number
  server_version_string: string
  fork_db_head_block_num: number
  fork_db_head_block_id: string
  server_full_version_string: string
  total_cpu_weight: number
  total_net_weight: number
  earliest_available_block_num: number
  last_irreversible_block_time: string
}

export interface WIREClientConfig {
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
export class WIREClient {
  public api: APIClient
  public clio: Clio

  constructor(public readonly config: WIREClientConfig) {
    this.api = new APIClient({ url: config.httpUrl })
    this.clio = new Clio(config.clio)
  }

  /** GET /v1/chain/get_info via sdk-core */
  async getInfo(): Promise<any> {
    return this.api.v1.chain.get_info()
  }

  /** GET table rows via sdk-core */
  async getTableRows<T = any>(params: {
    code: string
    scope: string
    table: string
    limit?: number
    lower_bound?: string
    upper_bound?: string
  }): Promise<GetTableRowsResponse<TableIndexType, T>> {
    const opts: Record<string, unknown> = {
      code: params.code,
      scope: params.scope,
      table: params.table,
      limit: params.limit || 100,
      json: true
    }
    if (params.lower_bound !== undefined) opts.lower_bound = params.lower_bound
    if (params.upper_bound !== undefined) opts.upper_bound = params.upper_bound
    return await this.api.v1.chain.get_table_rows(opts as any)
  }

  /** Read epoch state from sysio.epoch contract */
  async getEpochState(): Promise<any> {
    return this.getTableRows({
      code: "sysio.epoch",
      scope: "sysio.epoch",
      table: "epochstate"
    })
  }

  /** Read epoch config from sysio.epoch contract */
  async getEpochConfig(): Promise<any> {
    return this.getTableRows({
      code: "sysio.epoch",
      scope: "sysio.epoch",
      table: "epochcfg"
    })
  }

  /** Read operator roster from sysio.epoch contract */
  async getOperators() {
    return this.getTableRows<SystemContracts.SysioEpochOperatorInfoType>({
      code: "sysio.epoch",
      scope: "sysio.epoch",
      table: "operators"
    })
  }

  /** Read messages from sysio.msgch contract */
  async getMessages() {
    return this.getTableRows<SystemContracts.SysioMsgchMessageEntryType>({
      code: "sysio.msgch",
      scope: "sysio.msgch",
      table: "messages"
    })
  }

  /** Read inbound chain requests from sysio.msgch */
  async getChainRequests(): Promise<any> {
    return this.getTableRows({
      code: "sysio.msgch",
      scope: "sysio.msgch",
      table: "inchainreq"
    })
  }

  /** Read underwriting ledger from sysio.uwrit */
  async getUnderwritingLedger(): Promise<any> {
    return this.getTableRows({
      code: "sysio.uwrit",
      scope: "sysio.uwrit",
      table: "uwledger"
    })
  }

  /** Read collateral from sysio.uwrit */
  async getCollateral(): Promise<any> {
    return this.getTableRows({
      code: "sysio.uwrit",
      scope: "sysio.uwrit",
      table: "collateral"
    })
  }

  /** Read outpost registry from sysio.epoch */
  async getOutposts(): Promise<any> {
    return this.getTableRows({
      code: "sysio.epoch",
      scope: "sysio.epoch",
      table: "outposts"
    })
  }
}
