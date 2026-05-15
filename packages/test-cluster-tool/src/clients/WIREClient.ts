import { APIClient, SystemContracts } from "@wireio/sdk-core"
import { ChainKind, TokenKind } from "@wireio/opp-typescript-models"

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

  /**
   * Read the pending-withdraw queue from sysio.opreg.
   *
   * Rows land here when an operator (or their outpost on their behalf) calls
   * `opreg::withdraw` / `opreg::withdrawinle`; they age out as `flushwtdw`
   * reaches `eligible_at_epoch` each `sysio.epoch::advance` tick, at which
   * point an OPERATOR_ACTION(WITHDRAW_REMIT) is emitted outbound to the
   * holding outpost (or, for chain=WIRE, the funds transfer inline).
   *
   * Used by the collateral-lifecycle flow to assert (a) a row appears post-
   * `withdraw()` and (b) the row disappears after the wait window.
   */
  async getWithdrawQueue() {
    return this.getTableRows<any>({
      code: WIREClient.Contract.Opreg,
      scope: WIREClient.Contract.Opreg,
      table: WIREClient.OpregTable.WithdrawQueue
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

  /** Read underwrite requests from sysio.uwrit */
  async getUwRequests() {
    return this.getTableRows<any>({
      code: WIREClient.Contract.Uwrit,
      scope: WIREClient.Contract.Uwrit,
      table: WIREClient.UwritTable.UnderwriteRequests
    })
  }

  /** Read lock rows from sysio.uwrit. Each lock is one underwriter-side
   *  obligation for one leg of an in-flight UWREQ; pushed by
   *  `try_select_winner` and erased by `release`. */
  async getLocks() {
    return this.getTableRows<SystemContracts.SysioUwritLockEntryType>({
      code: WIREClient.Contract.Uwrit,
      scope: WIREClient.Contract.Uwrit,
      table: WIREClient.UwritTable.Locks
    })
  }

  /**
   * Provision a per-(chain, external-token) reserve on `sysio.reserv` via
   * the `setreserve` action. Flat `number` amounts; the `TokenAmount`
   * wire shape is built internally so test-time provisioning stays DRY.
   * Uses `pushActionAndWait` so the row is queryable immediately on
   * resolution.
   *
   * The connector-weight knob is omitted from the helper surface — today
   * `swapquote` ignores it and runs pure constant-product math, so the
   * action receives the default (5000 bps = constant product).
   *
   * @param chain          Outpost chain (ETHEREUM / SOLANA / SUI).
   * @param kind           Outpost-side TokenKind paired with WIRE in this
   *                        reserve. Must NOT be `TOKEN_KIND_WIRE`.
   * @param externalAmount Initial outpost-side balance.
   * @param wireAmount     Initial WIRE-side balance.
   */
  async seedReserve(
    chain: ChainKind,
    kind: TokenKind,
    externalAmount: number,
    wireAmount: number
  ): Promise<void> {
    const DEFAULT_CONNECTOR_WEIGHT_BPS = 5000
    // Post no-proto-messages-in-actions split: `setreserve` takes flat
    // `(chain, outpost_kind, outpost_amount, wire_amount,
    //  connector_weight_bps)` — no nested TokenAmount object on the wire
    // (which would leak vint64 typedefs into the ABI).
    await this.clio.pushActionAndWait<SystemContracts.SysioReservSetreserveAction>(
      "sysio.reserv",
      "setreserve",
      {
        // `ChainKind` / `TokenKind` (proto enums) ↔ `SysioReservChainkind` /
        // `SysioReservTokenkind` (system-contract enum mirrors) — identical
        // numeric values; cast bridges nominal typing.
        chain: chain as unknown as SystemContracts.SysioReservChainkind,
        outpost_kind: kind as unknown as SystemContracts.SysioReservTokenkind,
        outpost_amount: externalAmount,
        wire_amount: wireAmount,
        connector_weight_bps: DEFAULT_CONNECTOR_WEIGHT_BPS
      },
      "sysio.reserv@active"
    )
  }

  /**
   * Cross-chain swap quote for `(from_amount, to_chain, to_token)` —
   * the read-only `sysio.reserv::swapquote` surface, evaluated
   * client-side from the live `reserves` table.
   *
   * Mirrors the depot's `cp_output` math (constant-product, uint128-
   * safe) so callers can assert expected quotes before issuing a
   * SWAP_REQUEST. Uses `APIClient.v1.chain.get_table_rows` from
   * `@wireio/sdk-core` to read reserves; no extra RPC plumbing.
   *
   * @returns the destination amount (number), or `0` when any
   *          required reserve row is missing — matches the on-chain
   *          `swapquote` "no quote available" convention. Caller passes
   *          `toToken` so the destination kind is implicit; mirrors the
   *          contract's post-split `uint64` return.
   */
  async swapquote(
    fromKind: TokenKind,
    fromAmount: number,
    toChain: ChainKind,
    toToken: TokenKind
  ): Promise<number> {
    if (fromAmount <= 0) return 0
    if (fromKind === TokenKind.WIRE && toToken === TokenKind.WIRE) {
      return fromAmount
    }

    const { rows } = await this.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "reserves",
      limit: WIREClient.MaxReservesScan
    })

    const findReserve = (chain: ChainKind, kind: TokenKind) =>
      rows.find(
        (r: any) =>
          Number(r.chain) === Number(chain) &&
          Number(r.reserve_outpost_amount?.kind) === Number(kind)
      )

    const outpostAmt = (r: any) =>
      Number(r?.reserve_outpost_amount?.amount ?? 0)
    const wireAmt = (r: any) => Number(r?.reserve_wire_amount?.amount ?? 0)

    if (fromKind === TokenKind.WIRE) {
      const r = findReserve(toChain, toToken)
      if (!r) return 0
      return WIREClient.cpOutput(wireAmt(r), outpostAmt(r), fromAmount)
    }
    if (toToken === TokenKind.WIRE) {
      const r = findReserve(toChain, fromKind)
      if (!r) return 0
      return WIREClient.cpOutput(outpostAmt(r), wireAmt(r), fromAmount)
    }
    // Full hop: src->WIRE->dst, two reserves consulted.
    const srcR = findReserve(toChain, fromKind)
    const dstR = findReserve(toChain, toToken)
    if (!srcR || !dstR) return 0
    const wireIntermediate = WIREClient.cpOutput(
      outpostAmt(srcR),
      wireAmt(srcR),
      fromAmount
    )
    if (wireIntermediate === 0) return 0
    return WIREClient.cpOutput(
      wireAmt(dstR),
      outpostAmt(dstR),
      wireIntermediate
    )
  }
}

export namespace WIREClient {
  /** Default row limit for `getTableRows` when the caller doesn't specify one. */
  export const DefaultRowLimit = 100

  /** Upper bound for a single-page scan of `sysio.reserv::reserves`. The
   *  table is keyed `(chain, token_kind)` and grows linearly in
   *  configured pairs — a couple hundred is enough headroom for any
   *  cluster `swapquote` would target. */
  export const MaxReservesScan = 256

  /**
   * Constant-product output, uint128-safe via BigInt — matches
   * `sysio.reserv::cp_output` exactly. Returns 0 when any side is
   * zero or when src_amount is zero; saturates at JS `Number.MAX_SAFE_INTEGER`
   * (well below the on-chain uint64 cap, but every harness test sits
   * comfortably under it).
   */
  export function cpOutput(
    reserveSrc: number,
    reserveDst: number,
    srcAmount: number
  ): number {
    if (reserveSrc <= 0 || reserveDst <= 0 || srcAmount <= 0) return 0
    const num = BigInt(reserveDst) * BigInt(srcAmount)
    const den = BigInt(reserveSrc) + BigInt(srcAmount)
    const out = num / den
    return out > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Number(out)
  }

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
    Operators = "operators",
    WithdrawQueue = "wtdwqueue"
  }

  /** Tables on `sysio.msgch`. */
  export enum MsgchTable {
    Messages = "messages",
    Envelopes = "envelopes",
    Attestations = "attestations",
    OutEnvelopes = "outenvelopes"
  }

  /** Tables on `sysio.uwrit`. Post-Band-C the contract holds one row per
   *  uw_request (`uwreqs`) and one row per per-leg lock (`locks`); the
   *  pre-refactor `uwledger` / `collateral` tables are gone. */
  export enum UwritTable {
    UnderwriteRequests = "uwreqs",
    Locks = "locks"
  }
}
