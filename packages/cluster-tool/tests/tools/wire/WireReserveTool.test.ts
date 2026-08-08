import { SysioContracts } from "@wireio/sdk-core"
import type { WireClient } from "@wireio/cluster-tool/clients/wire"
import { WireReserveTool } from "@wireio/cluster-tool/tools/wire"

const { SysioContractName } = SysioContracts
const {
  BpsTotal,
  cpOutput,
  quoteSwap,
  splitWireFee,
  swapquote,
  varianceDrift
} = WireReserveTool

/** The old dev-cluster fee the recorded SwapFeeMath assertions were baselined on. */
const LegacySwapFeeBps = 10

/** A minimal reserves row carrying only the fields swapquote consults. */
interface QuoteReserveFixture {
  chain_code: { value: number }
  token_code: { value: number }
  reserve_code: { value: number }
  reserve_chain_amount: number
  reserve_wire_amount: number
}

const EthereumChain = 100,
  EthToken = 101,
  SolanaChain = 200,
  SolToken = 201,
  PrimaryReserve = 1

/** A WireClient stub whose reserv/uwrit typed accessors serve the fixtures. */
function stubWire(reserves: QuoteReserveFixture[], feeBps = 30): WireClient {
  const table = <Row>(rows: Row[]) => ({
    query: async () => ({ rows, more: false })
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
    it("0.1% fee with the 50/50 split (legacy 10 bps baseline)", () => {
      const fee = splitWireFee(99_009_900n, LegacySwapFeeBps)
      expect(fee.fee).toBe(99_009n)
      expect(fee.net).toBe(98_910_891n)
      expect(fee.rewardShare).toBe(49_504n)
      expect(fee.emissionsShare).toBe(49_505n)
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
        expect(fee.rewardShare + fee.emissionsShare).toBe(fee.fee)
        expect(fee.net + fee.fee).toBe(amount)
      })
    })
    it("floors toward zero", () => {
      expect(splitWireFee(5_000n, LegacySwapFeeBps).fee).toBe(5n)
      expect(splitWireFee(5_001n, LegacySwapFeeBps).fee).toBe(5n)
    })
    it("honours an explicit fee + reward share", () => {
      const fee = splitWireFee(1_000_000n, 100, BpsTotal)
      expect(fee.fee).toBe(10_000n)
      expect(fee.rewardShare).toBe(10_000n)
      expect(fee.emissionsShare).toBe(0n)
      expect(fee.net).toBe(990_000n)
    })
    it("clamps bps into [0, 10000]", () => {
      expect(splitWireFee(1_000n, -5).fee).toBe(0n)
      expect(splitWireFee(1_000n, 20_000).fee).toBe(1_000n)
    })
    it("zero amount yields all-zero shares", () => {
      const fee = splitWireFee(0n, LegacySwapFeeBps)
      expect(fee.fee).toBe(0n)
      expect(fee.rewardShare).toBe(0n)
      expect(fee.emissionsShare).toBe(0n)
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

  describe("quoteSwap (the sysio::opp::amm::quote_swap mirror)", () => {
    const book = { chain: 10_000_000_000n, wire: 10_000_000_000n }

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
    it("WIRE → WIRE is a plain transfer — no curve, no fee", () => {
      expect(quoteSwap(null, null, 42n, 30)).toBe(42n)
    })
    it("is 0n on degenerate input or a dry hop", () => {
      expect(quoteSwap(book, book, 0n, 30)).toBe(0n)
      expect(quoteSwap(book, book, -1n, 30)).toBe(0n)
      expect(quoteSwap({ chain: 0n, wire: 0n }, book, 100n, 30)).toBe(0n)
    })
  })

  describe("swapquote", () => {
    const reserves: QuoteReserveFixture[] = [
      {
        chain_code: { value: EthereumChain },
        token_code: { value: EthToken },
        reserve_code: { value: PrimaryReserve },
        reserve_chain_amount: 10_000_000_000,
        reserve_wire_amount: 10_000_000_000
      },
      {
        chain_code: { value: SolanaChain },
        token_code: { value: SolToken },
        reserve_code: { value: PrimaryReserve },
        reserve_chain_amount: 10_000_000_000,
        reserve_wire_amount: 10_000_000_000
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
