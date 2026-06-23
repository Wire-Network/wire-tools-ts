import { APIClient, SlugName, SystemContracts } from "@wireio/sdk-core"

import { Clio, type ClioConfig } from "./Clio.js"

/** SlugName packed `("WIRE"_c).value` — the depot's own chain code. */
const WireChainCode = SlugName.from("WIRE")
/** SlugName packed `("WIRE"_c).value` — the WIRE native token code. */
const WireTokenCode = SlugName.from("WIRE")

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

  /**
   * Real WIRE token balance (raw 9-decimal base units) for an account,
   * via `/v1/chain/get_currency_balance` against `sysio.token`. Returns
   * `0n` when the account holds no WIRE row. The WIRE-endpoint swap flows
   * assert the custody invariant with this (`Σ reserve_wire_amount ==
   * sysio.reserv's real balance + in-flight escrows`).
   *
   * @param account WIRE account name to query.
   * @return Raw base-unit balance as a bigint.
   */
  async getWireBalance(account: string): Promise<bigint> {
    const rows = (await this.api.v1.chain.get_currency_balance(
      "sysio.token",
      account,
      "WIRE"
    )) as unknown as Array<{ toString(): string }>
    if (!rows || rows.length === 0) return 0n
    // Asset string shape: "123.456789000 WIRE" — strip the symbol and
    // the decimal point to recover raw base units.
    const [amount] = rows[0].toString().split(" ")
    const [whole, frac = ""] = amount.split(".")
    return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"))
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
    // v6: depot KV tables (operators, epochstate, envelopes, chains,
    // tokens, reserves) return each row as `{ key: {...}, value: {...} }`.
    // The actual row fields live under `.value`. Unwrap centrally so
    // every caller sees a flat row shape compatible with v5-style
    // `.find(r => r.account === X)` access; rows without a `.value`
    // wrapper (non-KV multi_index tables) pass through unchanged.
    const rows = (result as any).rows ?? []
    const unwrapped = rows.map((r: any) =>
      r != null && typeof r === "object" && "value" in r ? r.value : r
    )
    return { rows: unwrapped as T[], more: (result as any).more ?? false }
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

  /**
   * Read the chain registry from `sysio.chains::chains`. Replaces the
   * pre-v6 `sysio.epoch::outposts` lookup — the outposts table is gone and
   * every chain (including the WIRE depot itself) lives on the new
   * `sysio.chains` contract keyed by `chain.code` slug_name.
   */
  async getChains() {
    return this.getTableRows<SystemContracts.SysioChainsChainRowType>({
      code: WIREClient.Contract.Chains,
      scope: WIREClient.Contract.Chains,
      table: WIREClient.ChainsTable.Chains
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
   * Provision a per-(chain_code, token_code, reserve_code) reserve on
   * `sysio.reserv` via the `regreserve` action. Bootstrap-window-only — the
   * action inserts the row with `status=ACTIVE` and pairs the
   * `initial_chain_amount` (outpost-side) with `initial_wire_amount`
   * (WIRE-side). Uses `pushActionAndWait` so the row is queryable
   * immediately on resolution.
   *
   * The connector-weight knob defaults to 5000 (50% Bancor weight = pure
   * constant product) which is what `swapquote` assumes today.
   *
   * @param chainCode    SlugName of the outpost chain (e.g.
   *   `SlugName.from("ETHEREUM")`).
   * @param tokenCode    SlugName of the outpost-side token (must not be
   *   `SlugName.from("WIRE")` — there is no WIRE-on-WIRE reserve).
   * @param reserveCode  SlugName of the reserve (typically
   *   `SlugName.from("PRIMARY")` for the bootstrap one).
   * @param externalAmount Initial outpost-side balance.
   * @param wireAmount     Initial WIRE-side balance.
   */
  async seedReserve(
    chainCode: number,
    tokenCode: number,
    reserveCode: number,
    externalAmount: number,
    wireAmount: number,
    isPrivate: boolean = false,
    owner: string = "",
    chainPrecision: number = 9
  ): Promise<void> {
    const DEFAULT_CONNECTOR_WEIGHT_BPS = 5000
    const name = `${SlugName.toString(chainCode)}-${SlugName.toString(tokenCode)}-${SlugName.toString(reserveCode)}`
    await this.clio.pushActionAndWait<SystemContracts.SysioReservRegreserveAction>(
      "sysio.reserv",
      "regreserve",
      {
        chain_code: { value: chainCode },
        token_code: { value: tokenCode },
        reserve_code: { value: reserveCode },
        name,
        description: `bootstrap-seeded reserve for ${name}`,
        initial_chain_amount: externalAmount,
        initial_wire_amount: wireAmount,
        // Depot-frame precision of the token side = min(native, 9). The
        // `initial_chain_amount` above is denominated in this precision.
        chain_precision: chainPrecision,
        connector_weight_bps: DEFAULT_CONNECTOR_WEIGHT_BPS,
        is_private: isPrivate,
        owner
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
    fromChainCode: number,
    fromTokenCode: number,
    fromReserveCode: number,
    fromAmount: number,
    toChainCode: number,
    toTokenCode: number,
    toReserveCode: number
  ): Promise<number> {
    if (fromAmount <= 0) return 0
    // A WIRE-on-WIRE leg has no reserve — pass-through 1:1.
    const fromIsWire =
      fromChainCode === WireChainCode && fromTokenCode === WireTokenCode
    const toIsWire =
      toChainCode === WireChainCode && toTokenCode === WireTokenCode
    if (fromIsWire && toIsWire) {
      return fromAmount
    }

    const { rows } = await this.getTableRows<any>({
      code: "sysio.reserv",
      scope: "sysio.reserv",
      table: "reserves",
      limit: WIREClient.MaxReservesScan
    })

    // Match on the (chain_code, token_code, reserve_code) triple — fields
    // are nested `{ value: number }` slug_name messages on the v6 reserves
    // table; some indexes may surface them as plain `number`s (e.g. when
    // the secondary read returns the unpacked uint64 directly), so accept
    // both shapes defensively.
    const codenameValue = (v: unknown): number =>
      typeof v === "object" && v !== null && "value" in v
        ? Number((v as { value: unknown }).value)
        : Number(v)
    const findReserve = (
      chainCode: number,
      tokenCode: number,
      reserveCode: number
    ) =>
      rows.find(
        (r: any) =>
          codenameValue(r.chain_code) === chainCode &&
          codenameValue(r.token_code) === tokenCode &&
          codenameValue(r.reserve_code) === reserveCode
      )

    const chainAmt = (r: any) => Number(r?.reserve_chain_amount ?? 0)
    const wireAmt = (r: any) => Number(r?.reserve_wire_amount ?? 0)

    if (fromIsWire) {
      const r = findReserve(toChainCode, toTokenCode, toReserveCode)
      if (!r) return 0
      return WIREClient.cpOutput(wireAmt(r), chainAmt(r), fromAmount)
    }
    if (toIsWire) {
      const r = findReserve(fromChainCode, fromTokenCode, fromReserveCode)
      if (!r) return 0
      return WIREClient.cpOutput(chainAmt(r), wireAmt(r), fromAmount)
    }
    // Full hop: src->WIRE->dst, two reserves consulted.
    const srcR = findReserve(fromChainCode, fromTokenCode, fromReserveCode)
    const dstR = findReserve(toChainCode, toTokenCode, toReserveCode)
    if (!srcR || !dstR) return 0
    const wireIntermediate = WIREClient.cpOutput(
      chainAmt(srcR),
      wireAmt(srcR),
      fromAmount
    )
    if (wireIntermediate === 0) return 0
    return WIREClient.cpOutput(
      wireAmt(dstR),
      chainAmt(dstR),
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

  /** Basis-point denominator (10000 = 100%). */
  export const BpsTotal = 10000

  /**
   * WIRE-leg swap fee in basis points that the dev cluster configures via
   * `sysio.uwrit::setconfig`. `sysio.uwrit`/`sysio.reserv` skim this off every
   * swap's WIRE intermediate before crediting the destination reserve. The
   * cluster bootstrap ({@link ClusterManager} Phase 17) sends this exact value,
   * and the swap flows mirror it to predict post-fee reserve books — so the two
   * MUST stay in lock-step. Changing it re-baselines every swap flow's expected
   * reserve / custody movement.
   */
  export const WireSwapFeeBps = 10

  /**
   * Reward share of the WIRE-leg fee, in basis points (the remainder routes to
   * the emissions treasury). Mirrors `sysio.reserv::FEE_REWARD_SHARE_BPS`
   * (5000 = a 50/50 reward/emissions split). The reward share is retained in
   * `sysio.reserv` custody as a rewards bucket; only the emissions share leaves
   * custody — so it is the half that shifts a flow's custody-balance assertion.
   */
  export const FeeRewardShareBps = 5000

  /**
   * Decomposition of a WIRE-leg swap fee — the TypeScript mirror of
   * `sysio::opp::amm::wire_fee`. Every field is an exact integer (BigInt)
   * quantity: `rewardShare + emissionsShare === fee` and `net + fee ===
   * wireAmount`, with no rounding leak.
   */
  export interface WireFee {
    /** Total fee charged on the WIRE leg. */
    fee: bigint
    /** Portion accrued to the rewards bucket — stays in `sysio.reserv` custody. */
    rewardShare: bigint
    /** Portion returned to the emissions treasury — leaves `sysio.reserv` custody. */
    emissionsShare: bigint
    /** `wireAmount - fee`: the net WIRE that continues through the swap. */
    net: bigint
  }

  /**
   * Split a gross WIRE amount into its swap fee and remainder, mirroring
   * `sysio::opp::amm::split_wire_fee` bit-for-bit (floored integer math, done in
   * BigInt). Swap flows use this to predict the post-fee reserve books and
   * custody movement the depot settles inline (`reserve::applyswap` /
   * `applyfromwire`): the destination reserve gains `net`, the source gives up
   * the full gross, and `fee` is routed to rewards (custody) + emissions (out).
   *
   * @param wireAmount     The gross WIRE leg — the constant-product intermediate
   *                       for a token source, or the user's escrowed WIRE for a
   *                       from-WIRE swap.
   * @param feeBps         Fee in basis points (defaults to {@link WireSwapFeeBps}).
   * @param rewardShareBps Reward share of the fee in bps (defaults to
   *                       {@link FeeRewardShareBps}).
   * @return The {@link WireFee} decomposition.
   * @example
   * // 0.1% fee on a 99_009_900 WIRE intermediate → 99_009 fee, 98_910_891 net.
   * splitWireFee(99_009_900n).net // 98_910_891n
   */
  export function splitWireFee(
    wireAmount: bigint,
    feeBps: number = WireSwapFeeBps,
    rewardShareBps: number = FeeRewardShareBps
  ): WireFee {
    const bps = BigInt(BpsTotal)
    const fb = BigInt(Math.min(Math.max(feeBps, 0), BpsTotal))
    const rb = BigInt(Math.min(Math.max(rewardShareBps, 0), BpsTotal))
    const fee = (wireAmount * fb) / bps
    const rewardShare = (fee * rb) / bps
    return {
      fee,
      rewardShare,
      emissionsShare: fee - rewardShare,
      net: wireAmount - fee
    }
  }

  /** System contract account names this client reads from. */
  export enum Contract {
    Chains = "sysio.chains",
    Epoch = "sysio.epoch",
    Opreg = "sysio.opreg",
    Msgch = "sysio.msgch",
    Uwrit = "sysio.uwrit"
  }

  /** Tables on `sysio.chains`. */
  export enum ChainsTable {
    Chains = "chains"
  }

  /** Tables on `sysio.epoch`. The pre-v6 `outposts` table is gone; chains
   *  live on `sysio.chains` now. */
  export enum EpochTable {
    EpochState = "epochstate",
    EpochConfig = "epochcfg"
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
