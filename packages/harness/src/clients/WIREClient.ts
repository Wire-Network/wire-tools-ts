import { APIClient, SystemContracts } from "@wireio/sdk-core"

import { Clio, type ClioConfig } from "./Clio.js"
import { log } from "../logger.js"

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
  async getInfo() {
    return this.api.v1.chain.get_info()
  }

  /** GET table rows via sdk-core */
  async getTableRows<T = unknown>(params: {
    code: string
    scope: string
    table: string
    limit?: number
    lower_bound?: string
    upper_bound?: string
  }) {
    const opts = {
      code: params.code,
      scope: params.scope,
      table: params.table,
      limit: params.limit || 100,
      json: true,
      lower_bound: params.lower_bound,
      upper_bound: params.upper_bound
    }
    const result = await this.api.v1.chain.get_table_rows(opts as any)
    return result as { rows: T[]; more: boolean }
  }

  /** Read epoch state from sysio.epoch contract */
  async getEpochState() {
    return this.getTableRows<SystemContracts.SysioEpochEpochStateType>({
      code: "sysio.epoch",
      scope: "sysio.epoch",
      table: "epochstate"
    })
  }

  /** Read epoch config from sysio.epoch contract */
  async getEpochConfig() {
    return this.getTableRows<SystemContracts.SysioEpochEpochConfigType>({
      code: "sysio.epoch",
      scope: "sysio.epoch",
      table: "epochcfg"
    })
  }

  /** Read operator roster from sysio.opreg contract */
  async getOperators() {
    return this.getTableRows<any>({
      code: "sysio.opreg",
      scope: "sysio.opreg",
      table: "operators"
    })
  }

  /** Read outpost registry from sysio.epoch */
  async getOutposts() {
    return this.getTableRows<SystemContracts.SysioEpochOutpostInfoType>({
      code: "sysio.epoch",
      scope: "sysio.epoch",
      table: "outposts"
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

  /** Read inbound envelopes from sysio.msgch (consensus tracking) */
  async getEnvelopes() {
    return this.getTableRows<any>({
      code: "sysio.msgch",
      scope: "sysio.msgch",
      table: "envelopes"
    })
  }

  /** Read attestations from sysio.msgch */
  async getAttestations() {
    return this.getTableRows<any>({
      code: "sysio.msgch",
      scope: "sysio.msgch",
      table: "attestations"
    })
  }

  /** Read outbound envelopes from sysio.msgch */
  async getOutboundEnvelopes() {
    return this.getTableRows<SystemContracts.SysioMsgchOutboundEnvelopeType>({
      code: "sysio.msgch",
      scope: "sysio.msgch",
      table: "outenvelopes"
    })
  }

  /** Read underwriting ledger from sysio.uwrit */
  async getUnderwritingLedger() {
    return this.getTableRows<SystemContracts.SysioUwritUnderwritingEntryType>({
      code: "sysio.uwrit",
      scope: "sysio.uwrit",
      table: "uwledger"
    })
  }

  /** Read underwrite requests from sysio.uwrit */
  async getUwRequests() {
    return this.getTableRows<any>({
      code: "sysio.uwrit",
      scope: "sysio.uwrit",
      table: "uwreqs"
    })
  }

  /** Read collateral from sysio.uwrit */
  async getCollateral() {
    return this.getTableRows<SystemContracts.SysioUwritCollateralEntryType>({
      code: "sysio.uwrit",
      scope: "sysio.uwrit",
      table: "collateral"
    })
  }
}
