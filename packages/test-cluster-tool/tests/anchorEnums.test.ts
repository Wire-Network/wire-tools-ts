import "jest"
import { OperatorType, TokenKind } from "@wireio/opp-typescript-models"
import { operatorTypeVariant, tokenKindVariant } from "@wireio/test-cluster-tool"

describe("anchorEnums", () => {
  describe("operatorTypeVariant", () => {
    test.each([
      [OperatorType.UNKNOWN,     { operatorTypeUnknown:     {} }],
      [OperatorType.PRODUCER,    { operatorTypeProducer:    {} }],
      [OperatorType.BATCH,       { operatorTypeBatch:       {} }],
      [OperatorType.UNDERWRITER, { operatorTypeUnderwriter: {} }],
      [OperatorType.CHALLENGER,  { operatorTypeChallenger:  {} }]
    ])("maps %s to the Anchor variant tag", (t, expected) => {
      expect(operatorTypeVariant(t)).toEqual(expected)
    })

    test("produces a fresh single-key object per call (no mutation aliasing)", () => {
      const a = operatorTypeVariant(OperatorType.BATCH)
      const b = operatorTypeVariant(OperatorType.BATCH)
      expect(a).toEqual(b)
      expect(Object.keys(a)).toHaveLength(1)
    })
  })

  describe("tokenKindVariant", () => {
    test.each([
      [TokenKind.WIRE,    { tokenKindWire:    {} }],
      [TokenKind.ETH,     { tokenKindEth:     {} }],
      [TokenKind.ERC20,   { tokenKindErc20:   {} }],
      [TokenKind.ERC721,  { tokenKindErc721:  {} }],
      [TokenKind.ERC1155, { tokenKindErc1155: {} }],
      [TokenKind.LIQETH,  { tokenKindLiqeth:  {} }],
      [TokenKind.SOL,     { tokenKindSol:     {} }],
      [TokenKind.LIQSOL,  { tokenKindLiqsol:  {} }]
    ])("maps %s to the Anchor variant tag", (k, expected) => {
      expect(tokenKindVariant(k)).toEqual(expected)
    })

    test("SOL kind serialises to the deposit-ix expected tag", () => {
      expect(tokenKindVariant(TokenKind.SOL)).toEqual({ tokenKindSol: {} })
    })
  })
})
