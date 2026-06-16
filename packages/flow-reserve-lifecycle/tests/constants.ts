import { SlugName } from "@wireio/sdk-core"
import { SwapUserIdentities } from "@wireio/test-cluster-tool"

/** Timing budgets — 60s epochs per `epoch-stall-is-fatal.md`. */
export namespace Timing {
  export const EpochDurationSec   = 60
  export const BootstrapTimeoutMs = 360_000
  /**
   * Outpost RESERVE_CREATE → OPP relay → depot `oncrtreserve` row insert.
   * Budget two epochs of envelope cadence plus relay slack.
   */
  export const RelayDeadlineMs    = 240_000
  /**
   * Depot RESERVE_READY / RESERVE_CREATE_CANCELLED round-trip back to the
   * outpost (local record flip + refund both ride inbound dispatch).
   */
  export const ReadyDeadlineMs    = 240_000
  /**
   * Window in which a FORBIDDEN UWREQ must NOT appear. ~1.5 epochs — long
   * enough for the SWAP_REQUEST to have relayed and been rejected, short
   * enough to keep the inverted poll cheap.
   */
  export const NoUwreqWindowMs    = 90_000
  export const LongPollIntervalMs = 3_000
}

/** Reserve identities driven through the gated create→match lifecycle. */
export namespace Reserves {
  export namespace Ethereum {
    export const ChainCode = SlugName.from("ETHEREUM")
    export const TokenCode = SlugName.from("ETH")
    /** The gated + PRIVATE reserve — linked creator, real WIRE match. */
    export const PrivateReserveCode = SlugName.from("PRIVRES")
    /**
     * The unlinked-creator reserve — depot cancels it back and the
     * outpost refunds. `NOLINKRS` (not `NOLINKRES`) because slug_names
     * cap at 8 characters.
     */
    export const NoLinkReserveCode = SlugName.from("NOLINKRS")
  }
  /** Public counterpart proving private↔public pairing is rejected. */
  export namespace Solana {
    export const ChainCode   = SlugName.from("SOLANA")
    export const TokenCode   = SlugName.from("SOL")
    export const ReserveCode = SlugName.from("PRIMARY")
  }
  /**
   * The WIRE endpoint identity for the `swapfromwire` exclusion probe.
   * There is no WIRE-side reserve; the depot rejects before any reserve
   * lookup on the WIRE leg.
   */
  export namespace Wire {
    export const ChainCode = SlugName.from("WIRE")
    export const TokenCode = SlugName.from("WIRE")
  }
}

/** create_reserve parameters for the two lifecycle reserves. */
export namespace CreateParams {
  /** 0.05 ETH escrowed into PRIVRES (msg.value — must equal the arg). */
  export const PrivateEscrowWei     = 50_000_000_000_000_000n
  /** 0.02 ETH escrowed into NOLINKRS — refunded on the cancel round-trip. */
  export const NoLinkEscrowWei      = 20_000_000_000_000_000n
  /**
   * WIRE (raw 9-dp base units) the matcher must escrow — `matchreserve`
   * requires `wire_amount == requested_wire_amount` EXACTLY, so the (b)
   * and (c) pushes both pass this verbatim.
   */
  export const RequestedWireAmount  = 1_000_000n
  /** 50% Bancor connector weight = pure constant product. */
  export const ConnectorWeightBps   = 5000
  /** Display metadata forwarded verbatim to the depot row. */
  export const PrivateName          = "ETHEREUM-ETH/WIRE private reserve"
  export const PrivateDescription   = "flow-reserve-lifecycle gated+private reserve"
  export const NoLinkName           = "ETHEREUM-ETH/WIRE unlinked-creator reserve"
  export const NoLinkDescription    = "flow-reserve-lifecycle cancelled-back reserve"
}

/**
 * Parameters for the rejected private↔public pairing probe ((f)). The
 * depot's privacy gate fires BEFORE the variance check, so a positive
 * sentinel target is enough — no quote computation needed.
 */
export namespace SwapProbe {
  /** 0.01 ETH source deposit (refunded by the SWAP_REVERT). */
  export const SourceEthereumWei = 10_000_000_000_000_000n
  /** Positive sentinel — never reaches the variance comparison. */
  export const TargetAmount      = 1n
  /** 5% — irrelevant to the privacy gate; matches template defaults. */
  export const ToleranceBps      = 500
}

/** Parameters for the `swapfromwire` private-exclusion probe ((g)). */
export namespace FromWireProbe {
  /** 0.001 WIRE — never escrowed; the push asserts before the transfer. */
  export const WireAmount   = 1_000_000n
  /** Positive sentinel — the privacy assert fires first. */
  export const TargetAmount = 1n
  export const ToleranceBps = 500
}

/** WIRE accounts provisioned by this flow. */
export namespace Accounts {
  /** The authex-linked matcher that legitimately activates PRIVRES. */
  export const Matcher             = "rsrvmatcher"
  /** Funded the same as Matcher but NEVER authex-linked. */
  export const WrongMatcher        = "wrongmatchr"
  /** 1 WIRE — covers the 0.001 WIRE match escrow with generous slack. */
  export const MatcherFunding      = 1_000_000_000n
  /** Same funding so only the missing link differentiates the rejection. */
  export const WrongMatcherFunding = 1_000_000_000n
}

/** ETH-side allowances for the unlinked-creator refund assertion ((e)). */
export namespace EthAllowances {
  /** 0.1 ETH seeded onto the fresh unlinked wallet from anvil signer 0. */
  export const NoLinkWalletFundingWei = 100_000_000_000_000_000n
  /**
   * 0.005 ETH gas allowance — after the refund lands, the creator's
   * balance must exceed `preCreate - this` (create_reserve gas is the
   * only unrecovered spend).
   */
  export const RefundGasAllowanceWei  = 5_000_000_000_000_000n
}

/** Anvil HD-derivation indices used by this flow. */
export namespace HdIndices {
  /**
   * The unlinked creator wallet — one past the shared swap-user slot so
   * it can never collide with an operator or the linked creator wallet.
   */
  export const NoLinkCreator = SwapUserIdentities.DefaultEthereumHdIndex + 1
}

/**
 * Local mirror of `ReserveManager.sol::LocalReserveStatus` (zero-indexed
 * one-byte storage enum: PENDING=0, ACTIVE=1, CANCELLED=2). Distinct from
 * the depot's proto `ReserveStatus` (UNKNOWN=0, PENDING=1, ACTIVE=2,
 * CANCELLED=3) — the translation happens at the outpost dispatch boundary.
 */
export enum EthLocalReserveStatus {
  PENDING = 0,
  ACTIVE = 1,
  CANCELLED = 2
}
