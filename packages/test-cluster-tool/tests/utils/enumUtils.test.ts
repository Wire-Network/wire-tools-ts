import { ChainKind, OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { abiEnumValue } from "@wireio/test-cluster-tool/utils"

const { SysioAuthexChainkind, SysioOpregOperatortype } = SysioContracts

describe("enumUtils", () => {
  describe("abiEnumValue", () => {
    it("resolves a proto ChainKind VALUE to its ABI-mirror member", () => {
      // The spellings differ (protobuf-ts strips the CHAIN_KIND_ prefix); the
      // numeric value is the invariant the bridge resolves through.
      expect(abiEnumValue(SysioAuthexChainkind, ChainKind.EVM)).toBe(
        SysioAuthexChainkind.CHAIN_KIND_EVM
      )
      expect(abiEnumValue(SysioAuthexChainkind, ChainKind.SVM)).toBe(
        SysioAuthexChainkind.CHAIN_KIND_SVM
      )
    })
    it("resolves a proto OperatorType VALUE to its ABI-mirror member", () => {
      expect(abiEnumValue(SysioOpregOperatortype, OperatorType.BATCH)).toBe(
        SysioOpregOperatortype.OPERATOR_TYPE_BATCH
      )
      expect(abiEnumValue(SysioOpregOperatortype, OperatorType.UNDERWRITER)).toBe(
        SysioOpregOperatortype.OPERATOR_TYPE_UNDERWRITER
      )
    })
    it("throws loudly when no ABI member is declared for the value", () => {
      expect(() => abiEnumValue(SysioAuthexChainkind, 999)).toThrow(
        /no ABI enum member is declared for proto value 999/
      )
    })
  })
})
