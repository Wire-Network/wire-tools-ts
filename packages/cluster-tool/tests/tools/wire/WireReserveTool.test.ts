import { SysioContracts } from "@wireio/sdk-core"
import type { WireClient } from "@wireio/cluster-tool/clients/wire"
import { WireReserveTool } from "@wireio/cluster-tool/tools/wire"

const { SysioContractName } = SysioContracts
const {
  BpsTotal,
  cpOutput,
  outGivenIn,
  quoteSwap,
  splitWireFee,
  swapquote,
  SymmetricConnectorWeightBps,
  tokenToWire,
  varianceDrift,
  wireToToken
} = WireReserveTool

/** The old dev-cluster fee the recorded SwapFeeMath assertions were baselined on. */
const LegacySwapFeeBps = 10

/** A minimal reserves row carrying only the fields swapquote consults. */
interface QuoteReserveFixture {
  chain_code: SysioContracts.SysioReservSlugNameType
  token_code: SysioContracts.SysioReservSlugNameType
  reserve_code: SysioContracts.SysioReservSlugNameType
  reserve_chain_amount: number
  reserve_wire_amount: number
  connector_weight_bps: number
  /** The reserve owner's fee on the WIRE leg — `0` for a public reserve. */
  owner_fee_bps: number
}

const EthereumChain = 100,
  EthToken = 101,
  SolanaChain = 200,
  SolToken = 201,
  PrimaryReserve = 1

/** A WireClient stub whose reserv/uwrit typed accessors serve the fixtures. */
function stubWire(reserves: QuoteReserveFixture[], feeBps = 30): WireClient {
  const table = <Row>(rows: Row[]) => ({
    query: async () => ({ rows, more: false, nextKey: null })
  })
  const clientByName = {
    [SysioContractName.reserv]: { tables: { reserves: table(reserves) } },
    [SysioContractName.uwrit]: {
      tables: {
        uwconfig: table([{ fee_bps: feeBps, collateral_lock_duration_ms: 0 }])
      }
    }
  }
  return {
    getSysioContract: (name: SysioContracts.SysioContractName) =>
      clientByName[name]
  } as WireClient
}

describe("WireReserveTool", () => {
  describe("cpOutput", () => {
    it("matches the depot's constant-product floor math", () => {
      // 1e10 books, 1e8 in → floor(1e10 × 1e8 / (1e10 + 1e8)) = 99_009_900
      expect(cpOutput(10_000_000_000n, 10_000_000_000n, 100_000_000n)).toBe(
        99_009_900n
      )
    })
    it("is 0n when any side is empty", () => {
      expect(cpOutput(0n, 10n, 5n)).toBe(0n)
      expect(cpOutput(10n, 0n, 5n)).toBe(0n)
      expect(cpOutput(10n, 10n, 0n)).toBe(0n)
    })
  })

  describe("splitWireFee (the recorded SwapFeeMath assertions)", () => {
    it("0.1% fee with the 50/50 underwriter / batch-operator split", () => {
      const fee = splitWireFee(99_009_900n, LegacySwapFeeBps)
      expect(fee.fee).toBe(99_009n)
      expect(fee.net).toBe(98_910_891n)
      expect(fee.underwriterShare).toBe(49_504n)
      expect(fee.rewardShare).toBe(49_505n)
    })
    it("holds the exact-integer invariants across amounts", () => {
      const amounts = [
        1n,
        7n,
        1_000_000n,
        99_009_900n,
        100_969_310n,
        80_000_000_000n
      ]
      amounts.forEach(amount => {
        const fee = splitWireFee(amount, LegacySwapFeeBps)
        expect(fee.underwriterShare + fee.rewardShare).toBe(fee.fee)
        expect(fee.net + fee.fee).toBe(amount)
      })
    })
    it("floors toward zero", () => {
      expect(splitWireFee(5_000n, LegacySwapFeeBps).fee).toBe(5n)
      expect(splitWireFee(5_001n, LegacySwapFeeBps).fee).toBe(5n)
    })
    it("honours an explicit fee + underwriter share", () => {
      const fee = splitWireFee(1_000_000n, 100, BpsTotal)
      expect(fee.fee).toBe(10_000n)
      expect(fee.underwriterShare).toBe(10_000n)
      expect(fee.rewardShare).toBe(0n)
      expect(fee.net).toBe(990_000n)
    })
    it("a zero underwriter share sends the whole fee to rewards (the revert path)", () => {
      // `sysio.reserv::refundwire` passes 0 — a revert has no winning
      // underwriter, so nothing accrues to `uwfees`.
      const fee = splitWireFee(1_000_000n, 100, 0)
      expect(fee.fee).toBe(10_000n)
      expect(fee.underwriterShare).toBe(0n)
      expect(fee.rewardShare).toBe(10_000n)
    })
    it("defaults to a zero emissions share — no fee leaves custody", () => {
      const fee = splitWireFee(1_000_000n, 1_000)
      expect(fee.emissionsShare).toBe(0n)
      expect(fee.underwriterShare).toBe(50_000n)
      expect(fee.rewardShare).toBe(50_000n)
    })
    it("the emissions share divides the REWARDS POOL, not the whole fee", () => {
      // fee 100_000 → underwriter 50_000, pool 50_000; 40% OF THE POOL = 20_000.
      const fee = splitWireFee(1_000_000n, 1_000, 5_000, 4_000)
      expect(fee.underwriterShare).toBe(50_000n)
      expect(fee.emissionsShare).toBe(20_000n)
      expect(fee.rewardShare).toBe(30_000n)
    })
    it("a full emissions share leaves batch operators nothing, underwriter untouched", () => {
      const fee = splitWireFee(1_000_000n, 1_000, 5_000, BpsTotal)
      expect(fee.underwriterShare).toBe(50_000n)
      expect(fee.emissionsShare).toBe(50_000n)
      expect(fee.rewardShare).toBe(0n)
    })
    it("charges each participating reserve's owner fee off the same gross leg", () => {
      // WIRE-281 "per reserve": a chain-to-chain swap pays THREE fees. All rates
      // apply to the gross leg, so they are additive and order-independent.
      // 1_000_000 leg: network 10% = 100_000; src 1% = 10_000; dst 2% = 20_000.
      const fee = splitWireFee(1_000_000n, 1_000, 5_000, 0, 100, 200)
      expect(fee.srcReserveShare).toBe(10_000n)
      expect(fee.dstReserveShare).toBe(20_000n)
      expect(fee.underwriterShare).toBe(50_000n)
      expect(fee.rewardShare).toBe(50_000n)
      expect(fee.fee).toBe(130_000n)
      expect(fee.net).toBe(870_000n)
    })
    it("a single-reserve path charges only its own side", () => {
      // paywire: source reserve only. applyfromwire: destination only.
      const source = splitWireFee(1_000_000n, 1_000, 5_000, 0, 100, 0)
      expect(source.srcReserveShare).toBe(10_000n)
      expect(source.dstReserveShare).toBe(0n)
      const destination = splitWireFee(1_000_000n, 1_000, 5_000, 0, 0, 200)
      expect(destination.srcReserveShare).toBe(0n)
      expect(destination.dstReserveShare).toBe(20_000n)
    })
    it("defaults both reserve rates to zero — a fee-free reserve pair", () => {
      const fee = splitWireFee(1_000_000n, 1_000, 5_000)
      expect(fee.srcReserveShare).toBe(0n)
      expect(fee.dstReserveShare).toBe(0n)
      expect(fee.fee).toBe(100_000n)
    })
    it("saturates net at zero rather than going negative when rates fill the leg", () => {
      const fee = splitWireFee(1_000n, BpsTotal, 5_000, 0, BpsTotal, BpsTotal)
      expect(fee.net).toBe(0n)
    })
    it("holds five-way conservation with reserve fees stacked on", () => {
      const amounts = [1n, 7n, 999n, 1_000_003n, 1_000_000_000_000n]
      amounts.forEach(amount => {
        const fee = splitWireFee(amount, 137, 5_000, 3_333, 97, 211)
        expect(
          fee.underwriterShare +
            fee.rewardShare +
            fee.emissionsShare +
            fee.srcReserveShare +
            fee.dstReserveShare
        ).toBe(fee.fee)
        expect(fee.net + fee.fee).toBe(amount)
      })
    })
    it("holds three-way conservation across odd amounts and shares", () => {
      const emissionsShares = [0, 1, 3_333, 5_000, 9_999, BpsTotal],
        amounts = [1n, 7n, 999n, 1_000_003n, 1_000_000_000_000n]
      emissionsShares.forEach(emissions =>
        amounts.forEach(amount => {
          const fee = splitWireFee(amount, 137, 5_000, emissions)
          expect(
            fee.underwriterShare + fee.rewardShare + fee.emissionsShare
          ).toBe(fee.fee)
          expect(fee.net + fee.fee).toBe(amount)
        })
      )
    })
    it("clamps bps into [0, 10000]", () => {
      expect(splitWireFee(1_000n, -5).fee).toBe(0n)
      expect(splitWireFee(1_000n, 20_000).fee).toBe(1_000n)
      // The share bps clamp the same way, on both ends.
      expect(splitWireFee(1_000_000n, BpsTotal, -5).underwriterShare).toBe(0n)
      expect(splitWireFee(1_000_000n, BpsTotal, 20_000).underwriterShare).toBe(1_000_000n)
    })
    it("zero amount yields all-zero shares", () => {
      const fee = splitWireFee(0n, LegacySwapFeeBps)
      expect(fee.fee).toBe(0n)
      expect(fee.underwriterShare).toBe(0n)
      expect(fee.rewardShare).toBe(0n)
      expect(fee.net).toBe(0n)
    })
  })

  describe("varianceDrift", () => {
    it("floors target × bps / 10000", () => {
      expect(varianceDrift(98_000_000n, 200)).toBe(1_960_000n)
      expect(varianceDrift(3n, 500)).toBe(0n)
    })
  })

  describe("toDepot / fromDepot (per-token depot precision = min(native, 9))", () => {
    it("depotPrecision caps at 9 and passes sub-cap precision through", () => {
      expect(WireReserveTool.depotPrecision(6)).toBe(6)
      expect(WireReserveTool.depotPrecision(9)).toBe(9)
      expect(WireReserveTool.depotPrecision(18)).toBe(9)
    })

    it("carries an at-or-below-cap token at NATIVE precision (6-dec identity)", () => {
      expect(WireReserveTool.toDepot(100_000n, 6)).toBe(100_000n)
      expect(WireReserveTool.fromDepot(100_000n, 6)).toBe(100_000n)
    })

    it("is identity at exactly 9 decimals (lamports)", () => {
      expect(WireReserveTool.toDepot(10_000_000_000n, 9)).toBe(10_000_000_000n)
      expect(WireReserveTool.fromDepot(10_000_000_000n, 9)).toBe(
        10_000_000_000n
      )
    })

    it("downscales an above-cap token (18-dec wei → ÷1e9, floored)", () => {
      expect(WireReserveTool.toDepot(1_500_000_000_999_999_999n, 18)).toBe(
        1_500_000_000n
      )
    })

    it("fromDepot upscales an above-cap token (18-dec wei → ×1e9)", () => {
      expect(WireReserveTool.fromDepot(4_754_411_063n, 18)).toBe(
        4_754_411_063_000_000_000n
      )
    })

    it("rejects a zero / non-integer decimals argument", () => {
      expect(() => WireReserveTool.toDepot(1n, 0)).toThrow(
        /invalid native decimals/
      )
      expect(() => WireReserveTool.fromDepot(1n, 1.5)).toThrow(
        /invalid native decimals/
      )
      expect(() => WireReserveTool.depotPrecision(-1)).toThrow(
        /invalid native decimals/
      )
    })
  })

  describe("readFeeBps", () => {
    it("reads the live uwconfig singleton", async () => {
      await expect(WireReserveTool.readFeeBps(stubWire([], 30))).resolves.toBe(
        30
      )
    })
  })

  // Every expected value below was produced by COMPILING
  // `sysio.opp.common/amm_math.hpp` and printing `out_given_in` for the same
  // inputs — not derived by hand. A mirror that merely approximates the depot
  // is not a mirror; these pin bit-identity, including the Q60 log2/exp2 path.
  describe("outGivenIn (the sysio::opp::amm::out_given_in mirror)", () => {
    const Balance = 10_000_000_000n,
      AmountIn = 100_000_000n

    it("takes the EXACT constant-product path at equal weights", () => {
      expect(
        outGivenIn(Balance, 5_000n, Balance, 5_000n, AmountIn)
      ).toBe(99_009_900n)
      // The symmetric case must agree with the pure integer curve exactly.
      expect(outGivenIn(Balance, 5_000n, Balance, 5_000n, AmountIn)).toBe(
        cpOutput(Balance, Balance, AmountIn)
      )
    })

    it.each([
      [2_000n, 8_000n, 24_844_912n],
      [8_000n, 2_000n, 390_196_555n],
      [1_000n, 9_000n, 11_049_813n],
      [9_000n, 1_000n, 856_601_757n],
      [2_500n, 7_500n, 33_112_825n]
    ])(
      "matches the contract at wIn=%s wOut=%s",
      (weightIn, weightOut, expected) => {
        expect(
          outGivenIn(Balance, weightIn, Balance, weightOut, AmountIn)
        ).toBe(expected)
      }
    )

    it("matches the contract at a larger input on the same pool", () => {
      expect(
        outGivenIn(Balance, 2_500n, Balance, 7_500n, 1_000_000_000n)
      ).toBe(312_706_938n)
    })

    it("matches the contract on an asymmetric-depth pool", () => {
      expect(
        outGivenIn(5_000_000_000n, 3_000n, 20_000_000_000n, 7_000n, 250_000_000n)
      ).toBe(413_859_413n)
    })

    it("diverges from equal-weight constant product off 50/50", () => {
      // The whole point of the fix: cpOutput is only the curve at cw == 5000.
      expect(
        outGivenIn(Balance, 2_000n, Balance, 8_000n, AmountIn)
      ).not.toBe(cpOutput(Balance, Balance, AmountIn))
    })

    it("is 0n on a degenerate balance, weight, or amount", () => {
      expect(outGivenIn(0n, 5_000n, Balance, 5_000n, AmountIn)).toBe(0n)
      expect(outGivenIn(Balance, 5_000n, 0n, 5_000n, AmountIn)).toBe(0n)
      expect(outGivenIn(Balance, 0n, Balance, 5_000n, AmountIn)).toBe(0n)
      expect(outGivenIn(Balance, 5_000n, Balance, 0n, AmountIn)).toBe(0n)
      expect(outGivenIn(Balance, 5_000n, Balance, 5_000n, 0n)).toBe(0n)
    })

    it("never pays out more than the output side holds", () => {
      expect(
        outGivenIn(1n, 5_000n, Balance, 5_000n, 10n ** 18n)
      ).toBeLessThanOrEqual(Balance)
    })
  })

  describe("tokenToWire / wireToToken (the convenience mirrors)", () => {
    const Balance = 10_000_000_000n,
      Amount = 100_000_000n

    it("route connectorWeightBps to the correct SIDE", () => {
      // cw is the WIRE-side weight: token→wire has it as weightOut,
      // wire→token as weightIn. Swapping them is the easy mistake, and these
      // two values differ by more than an order of magnitude at cw=8000.
      expect(tokenToWire(Balance, Balance, 8_000, Amount)).toBe(24_844_912n)
      expect(wireToToken(Balance, Balance, 8_000, Amount)).toBe(390_196_555n)
    })

    it("collapse to constant product at the symmetric weight", () => {
      const cp = cpOutput(Balance, Balance, Amount)
      expect(
        tokenToWire(Balance, Balance, SymmetricConnectorWeightBps, Amount)
      ).toBe(cp)
      expect(
        wireToToken(Balance, Balance, SymmetricConnectorWeightBps, Amount)
      ).toBe(cp)
    })
  })

  describe("quoteSwap (the sysio::opp::amm::quote_swap mirror)", () => {
    const book = {
      chain: 10_000_000_000n,
      wire: 10_000_000_000n,
      connectorWeightBps: SymmetricConnectorWeightBps,
      ownerFeeBps: 0
    }

    it("charges the WIRE-leg fee BETWEEN the hops, not on the output", () => {
      const gross = cpOutput(book.chain, book.wire, 100_000_000n),
        net = splitWireFee(gross, 30).net
      // Fee before the destination conversion — NOT cp(...gross) reduced after.
      expect(quoteSwap(book, book, 100_000_000n, 30)).toBe(
        cpOutput(book.wire, book.chain, net)
      )
      expect(quoteSwap(book, book, 100_000_000n, 30)).not.toBe(
        splitWireFee(cpOutput(book.wire, book.chain, gross), 30).net
      )
    })
    it("a WIRE destination receives the post-fee WIRE leg itself", () => {
      const gross = cpOutput(book.chain, book.wire, 100_000_000n)
      expect(quoteSwap(book, null, 100_000_000n, 30)).toBe(
        splitWireFee(gross, 30).net
      )
    })
    it("a WIRE source feeds the escrow straight into the WIRE leg", () => {
      expect(quoteSwap(null, book, 100_000_000n, 30)).toBe(
        cpOutput(book.wire, book.chain, splitWireFee(100_000_000n, 30).net)
      )
    })
    it("rides the WEIGHTED curve when the reserve is not 50/50", () => {
      // Contract value for cw=8000 on both legs at 30 bps.
      const weighted = {
        chain: 10_000_000_000n,
        wire: 10_000_000_000n,
        connectorWeightBps: 8_000,
        ownerFeeBps: 0
      }
      expect(quoteSwap(weighted, weighted, 100_000_000n, 30)).toBe(98_470_966n)
      // …and that is NOT what the equal-weight curve would have quoted.
      expect(quoteSwap(weighted, weighted, 100_000_000n, 30)).not.toBe(
        quoteSwap(book, book, 100_000_000n, 30)
      )
    })
    it("WIRE → WIRE is a plain transfer — no curve, no fee", () => {
      expect(quoteSwap(null, null, 42n, 30)).toBe(42n)
    })
    // The regression this whole field exists for: a PUBLIC reserve carries
    // ownerFeeBps 0, so a quote that drops the owner fee is right everywhere
    // except the one flow that configures one — where it silently over-quotes
    // the destination and the books assertion fails by the owner fee.
    it("charges BOTH reserve owners on the same gross leg as the network fee", () => {
      const owned = { ...book, ownerFeeBps: 100 },
        gross = cpOutput(book.chain, book.wire, 100_000_000n)
      expect(quoteSwap(owned, owned, 100_000_000n, 30)).toBe(
        cpOutput(book.wire, book.chain, splitWireFee(gross, 30, 0, 0, 100, 100).net)
      )
      // Strictly less than the same books with no owner fee — the exact gap
      // that made the private-reserve flow's target over-predict.
      expect(quoteSwap(owned, owned, 100_000_000n, 30)).toBeLessThan(
        quoteSwap(book, book, 100_000_000n, 30)
      )
    })
    it("a WIRE endpoint charges no owner fee on its side", () => {
      // Only the SOURCE reserve's owner fee can apply when the destination is
      // WIRE — mirroring the contract's `src_is_wire ? 0 : …` carve-out.
      const owned = { ...book, ownerFeeBps: 250 },
        gross = cpOutput(book.chain, book.wire, 100_000_000n)
      expect(quoteSwap(owned, null, 100_000_000n, 30)).toBe(
        splitWireFee(gross, 30, 0, 0, 250, 0).net
      )
      expect(quoteSwap(null, owned, 100_000_000n, 30)).toBe(
        cpOutput(
          book.wire,
          book.chain,
          splitWireFee(100_000_000n, 30, 0, 0, 0, 250).net
        )
      )
    })
    it("is 0n on degenerate input or a dry hop", () => {
      expect(quoteSwap(book, book, 0n, 30)).toBe(0n)
      expect(quoteSwap(book, book, -1n, 30)).toBe(0n)
      expect(
        quoteSwap(
          {
            chain: 0n,
            wire: 0n,
            connectorWeightBps: SymmetricConnectorWeightBps,
            ownerFeeBps: 0
          },
          book,
          100n,
          30
        )
      ).toBe(0n)
    })
  })

  describe("swapquote", () => {
    const reserves: QuoteReserveFixture[] = [
      {
        chain_code: { value: EthereumChain },
        token_code: { value: EthToken },
        reserve_code: { value: PrimaryReserve },
        reserve_chain_amount: 10_000_000_000,
        reserve_wire_amount: 10_000_000_000,
        connector_weight_bps: SymmetricConnectorWeightBps,
        owner_fee_bps: 0
      },
      {
        chain_code: { value: SolanaChain },
        token_code: { value: SolToken },
        reserve_code: { value: PrimaryReserve },
        reserve_chain_amount: 10_000_000_000,
        reserve_wire_amount: 10_000_000_000,
        connector_weight_bps: SymmetricConnectorWeightBps,
        owner_fee_bps: 0
      }
    ]
    const ethereumTriple = {
        chainCode: EthereumChain,
        tokenCode: EthToken,
        reserveCode: PrimaryReserve
      },
      solanaTriple = {
        chainCode: SolanaChain,
        tokenCode: SolToken,
        reserveCode: PrimaryReserve
      },
      wireTriple = {
        chainCode: WireReserveTool.WireChainCode,
        tokenCode: WireReserveTool.WireTokenCode,
        reserveCode: PrimaryReserve
      }

    it("full hop routes source → WIRE → destination through both books, fee between the hops", async () => {
      const quote = await swapquote(stubWire(reserves), {
        from: ethereumTriple,
        fromAmount: 100_000_000n,
        to: solanaTriple
      })
      // Gross intermediate cp(1e10, 1e10, 1e8) = 99_009_900; the 30 bps fee
      // comes off it, and only the net converts on the destination curve.
      const net = splitWireFee(99_009_900n, 30).net
      expect(quote).toBe(cpOutput(10_000_000_000n, 10_000_000_000n, net))
      expect(quote).toBe(97_747_972n)
    })
    it("to-WIRE consults only the source book and pays the post-fee leg", async () => {
      const quote = await swapquote(stubWire(reserves), {
        from: ethereumTriple,
        fromAmount: 100_000_000n,
        to: wireTriple
      })
      expect(quote).toBe(splitWireFee(99_009_900n, 30).net)
    })
    it("from-WIRE takes the fee off the escrow before the destination curve", async () => {
      const quote = await swapquote(stubWire(reserves), {
        from: wireTriple,
        fromAmount: 100_000_000n,
        to: solanaTriple
      })
      const net = splitWireFee(100_000_000n, 30).net
      expect(quote).toBe(cpOutput(10_000_000_000n, 10_000_000_000n, net))
      expect(quote).toBe(98_715_803n)
    })
    it("honours the live uwconfig fee rather than a hardcoded rate", async () => {
      const quote = await swapquote(stubWire(reserves, 0), {
        from: wireTriple,
        fromAmount: 100_000_000n,
        to: solanaTriple
      })
      // A zero-fee cluster is the only case where the quote is the raw curve.
      expect(quote).toBe(99_009_900n)
    })
    it("WIRE → WIRE passes through 1:1", async () => {
      await expect(
        swapquote(stubWire([]), {
          from: wireTriple,
          fromAmount: 42n,
          to: wireTriple
        })
      ).resolves.toBe(42n)
    })
    it("is 0n when a required reserve row is missing", async () => {
      await expect(
        swapquote(stubWire([]), {
          from: ethereumTriple,
          fromAmount: 100_000_000n,
          to: solanaTriple
        })
      ).resolves.toBe(0n)
    })
  })
})
