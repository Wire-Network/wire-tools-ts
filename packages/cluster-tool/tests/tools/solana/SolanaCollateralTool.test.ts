import { PublicKey } from "@solana/web3.js"
import { OperatorType } from "@wireio/opp-typescript-models"
import { SolanaCollateralTool } from "@wireio/cluster-tool/tools/solana"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

/**
 * The seed contract these helpers mirror lives in
 * `wire-solana/programs/liqsol-core/src/states/opp_states.rs`
 * (`COLLATERAL_POSITION_SEED`) and the `Deposit` / `DepositNonNative` account
 * structs in `.../instructions/opp/deposit.rs`. The program is built with
 * Anchor `resolution = false`, so NOTHING is auto-derived from the IDL — every
 * account is supplied explicitly and these derivations are load-bearing.
 */
describe("SolanaCollateralTool.collateralPositionPda", () => {
  const programId = PublicKey.unique()
  const operator = PublicKey.unique()
  /** An arbitrary fixed token code — the derivation is value-agnostic. ASCII "SOL", NOT SlugName.from("SOL"). */
  const tokenCode = 0x534f4cn

  it("matches an independent derivation of the on-chain seed list", () => {
    const tokenCodeLeBytes = Buffer.alloc(8)
    tokenCodeLeBytes.writeBigUInt64LE(tokenCode)
    const [expected] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("collateral_position"),
        operator.toBuffer(),
        tokenCodeLeBytes
      ],
      programId
    )
    expect(
      SolanaCollateralTool.collateralPositionPda(
        programId,
        operator,
        tokenCode
      ).toBase58()
    ).toBe(expected.toBase58())
  })

  it("is deterministic for the same (operator, tokenCode)", () => {
    expect(
      SolanaCollateralTool.collateralPositionPda(
        programId,
        operator,
        tokenCode
      ).toBase58()
    ).toBe(
      SolanaCollateralTool.collateralPositionPda(
        programId,
        operator,
        tokenCode
      ).toBase58()
    )
  })

  it("gives a DISTINCT position per operator and per tokenCode", () => {
    const otherOperator = PublicKey.unique()
    const base = SolanaCollateralTool.collateralPositionPda(
      programId,
      operator,
      tokenCode
    )
    expect(
      SolanaCollateralTool.collateralPositionPda(
        programId,
        otherOperator,
        tokenCode
      ).toBase58()
    ).not.toBe(base.toBase58())
    expect(
      SolanaCollateralTool.collateralPositionPda(
        programId,
        operator,
        tokenCode + 1n
      ).toBase58()
    ).not.toBe(base.toBase58())
  })

  it("is scoped to the program id", () => {
    expect(
      SolanaCollateralTool.collateralPositionPda(
        PublicKey.unique(),
        operator,
        tokenCode
      ).toBase58()
    ).not.toBe(
      SolanaCollateralTool.collateralPositionPda(
        programId,
        operator,
        tokenCode
      ).toBase58()
    )
  })
})

/**
 * SOL-432: the SPL collateral deposit carries NO reserve dimension. The depot
 * keys collateral by `token_code` alone and never reads `reserve_code` on a
 * DEPOSIT_REQUEST (a SLASH-only field per the OPP proto), so the outpost IX
 * takes `(chainCode, tokenCode, operatorType, amount)` and nothing else.
 */
describe("SolanaCollateralTool.planNonNativeDeposit", () => {
  it("captures the full typed input and binds the named runner", () => {
    const step = SolanaCollateralTool.planNonNativeDeposit(
      Report.Actor.Underwriter,
      "deposit-usdc",
      "Underwriter bonds USDC collateral",
      {},
      "uwrit.a",
      2n,
      7n,
      OperatorType.UNDERWRITER,
      1_000_000n
    )
    // `toEqual` is exact, so this also pins the ABSENCE of a reserve dimension —
    // re-introducing `reserveCode` on the StepInput fails here.
    expect(step.input).toEqual({
      kind: "SolanaCollateralTool.DepositNonNativeInput",
      operatorLabel: "uwrit.a",
      chainCode: 2n,
      tokenCode: 7n,
      operatorType: OperatorType.UNDERWRITER,
      amount: 1_000_000n
    })
    expect(step.runner).toBe(SolanaCollateralTool.runNonNativeDeposit)
  })

  it("runner rejects a non-positive amount before touching any client", async () => {
    // The amount guard fires before any client getter is touched.
    const ctx = fixtureContext()
    await expect(
      SolanaCollateralTool.runNonNativeDeposit(
        ctx,
        {
          kind: "SolanaCollateralTool.DepositNonNativeInput",
          operatorLabel: "uwrit.a",
          chainCode: 2n,
          tokenCode: 7n,
          operatorType: OperatorType.UNDERWRITER,
          amount: 0n
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/amount must be positive/)
  })
})
