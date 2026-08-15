import { PublicKey } from "@solana/web3.js"
import { SolanaCollateralTool } from "@wireio/cluster-tool/tools/solana"

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
  const tokenCode = 0x534f4cn

  it("matches an independent derivation of the on-chain seed list", () => {
    const tokenCodeLeBytes = Buffer.alloc(8)
    tokenCodeLeBytes.writeBigUInt64LE(tokenCode)
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("collateral_position"), operator.toBuffer(), tokenCodeLeBytes],
      programId
    )
    expect(
      SolanaCollateralTool.collateralPositionPda(programId, operator, tokenCode).toBase58()
    ).toBe(expected.toBase58())
  })

  it("is deterministic for the same (operator, tokenCode)", () => {
    expect(
      SolanaCollateralTool.collateralPositionPda(programId, operator, tokenCode).toBase58()
    ).toBe(
      SolanaCollateralTool.collateralPositionPda(programId, operator, tokenCode).toBase58()
    )
  })

  it("gives a DISTINCT position per operator and per tokenCode", () => {
    const otherOperator = PublicKey.unique()
    const base = SolanaCollateralTool.collateralPositionPda(programId, operator, tokenCode)
    expect(
      SolanaCollateralTool.collateralPositionPda(programId, otherOperator, tokenCode).toBase58()
    ).not.toBe(base.toBase58())
    expect(
      SolanaCollateralTool.collateralPositionPda(programId, operator, tokenCode + 1n).toBase58()
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
      SolanaCollateralTool.collateralPositionPda(programId, operator, tokenCode).toBase58()
    )
  })
})
