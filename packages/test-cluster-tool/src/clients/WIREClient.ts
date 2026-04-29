import { APIClient, SystemContracts } from "@wireio/sdk-core"

import { Clio, type ClioConfig } from "./Clio.js"

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

  /**
   * GET table rows via sdk-core. Defaults `limit` to {@link WIREClient.DefaultRowLimit}
   * and `json: true` (the only supported encoding for these consumers).
   */
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
      limit: params.limit || WIREClient.DefaultRowLimit,
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
      code: WIREClient.Contract.Epoch,
      scope: WIREClient.Contract.Epoch,
      table: WIREClient.EpochTable.EpochState
    })
  }

  /** Read epoch config from sysio.epoch contract */
  async getEpochConfig() {
    return this.getTableRows<SystemContracts.SysioEpochEpochConfigType>({
      code: WIREClient.Contract.Epoch,
      scope: WIREClient.Contract.Epoch,
      table: WIREClient.EpochTable.EpochConfig
    })
  }

  /** Read operator roster from sysio.opreg contract */
  async getOperators() {
    return this.getTableRows<any>({
      code: WIREClient.Contract.Opreg,
      scope: WIREClient.Contract.Opreg,
      table: WIREClient.OpregTable.Operators
    })
  }

  /** Read outpost registry from sysio.epoch */
  async getOutposts() {
    return this.getTableRows<SystemContracts.SysioEpochOutpostInfoType>({
      code: WIREClient.Contract.Epoch,
      scope: WIREClient.Contract.Epoch,
      table: WIREClient.EpochTable.Outposts
    })
  }

  /** Read messages from sysio.msgch contract */
  async getMessages() {
    return this.getTableRows<SystemContracts.SysioMsgchMessageEntryType>({
      code: WIREClient.Contract.Msgch,
      scope: WIREClient.Contract.Msgch,
      table: WIREClient.MsgchTable.Messages
    })
  }

  /** Read inbound envelopes from sysio.msgch (consensus tracking) */
  async getEnvelopes() {
    return this.getTableRows<any>({
      code: WIREClient.Contract.Msgch,
      scope: WIREClient.Contract.Msgch,
      table: WIREClient.MsgchTable.Envelopes
    })
  }

  /** Read attestations from sysio.msgch */
  async getAttestations() {
    return this.getTableRows<any>({
      code: WIREClient.Contract.Msgch,
      scope: WIREClient.Contract.Msgch,
      table: WIREClient.MsgchTable.Attestations
    })
  }

  /** Read outbound envelopes from sysio.msgch */
  async getOutboundEnvelopes() {
    return this.getTableRows<SystemContracts.SysioMsgchOutboundEnvelopeType>({
      code: WIREClient.Contract.Msgch,
      scope: WIREClient.Contract.Msgch,
      table: WIREClient.MsgchTable.OutEnvelopes
    })
  }

  /** Read underwriting ledger from sysio.uwrit */
  async getUnderwritingLedger() {
    return this.getTableRows<SystemContracts.SysioUwritUnderwritingEntryType>({
      code: WIREClient.Contract.Uwrit,
      scope: WIREClient.Contract.Uwrit,
      table: WIREClient.UwritTable.UnderwritingLedger
    })
  }

  /** Read underwrite requests from sysio.uwrit */
  async getUwRequests() {
    return this.getTableRows<any>({
      code: WIREClient.Contract.Uwrit,
      scope: WIREClient.Contract.Uwrit,
      table: WIREClient.UwritTable.UnderwriteRequests
    })
  }

  /** Read collateral from sysio.uwrit */
  async getCollateral() {
    return this.getTableRows<SystemContracts.SysioUwritCollateralEntryType>({
      code: WIREClient.Contract.Uwrit,
      scope: WIREClient.Contract.Uwrit,
      table: WIREClient.UwritTable.Collateral
    })
  }
}

export namespace WIREClient {
  /** Default row limit for `getTableRows` when the caller doesn't specify one. */
  export const DefaultRowLimit = 100

  /** System contract account names this client reads from. */
  export enum Contract {
    Epoch = "sysio.epoch",
    Opreg = "sysio.opreg",
    Msgch = "sysio.msgch",
    Uwrit = "sysio.uwrit"
  }

  /** Tables on `sysio.epoch`. */
  export enum EpochTable {
    EpochState = "epochstate",
    EpochConfig = "epochcfg",
    Outposts = "outposts"
  }

  /** Tables on `sysio.opreg`. */
  export enum OpregTable {
    Operators = "operators"
  }

  /** Tables on `sysio.msgch`. */
  export enum MsgchTable {
    Messages = "messages",
    Envelopes = "envelopes",
    Attestations = "attestations",
    OutEnvelopes = "outenvelopes"
  }

  /** Tables on `sysio.uwrit`. */
  export enum UwritTable {
    UnderwritingLedger = "uwledger",
    UnderwriteRequests = "uwreqs",
    Collateral = "collateral"
  }
}
