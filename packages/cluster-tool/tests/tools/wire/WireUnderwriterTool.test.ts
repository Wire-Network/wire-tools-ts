import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { ChainTokenAmount } from "@wireio/cluster-tool-shared"
import { TokenAmount } from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"

import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { WireUnderwriterTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

const WireChain = SlugName.from("WIRE")
const EthChain = SlugName.from("ETHEREUM")
const SolChain = SlugName.from("SOLANA")
const EthToken = SlugName.from("ETH")
const SolToken = SlugName.from("SOL")
const UsdcToken = SlugName.from("USDC")

/** A fresh build root (a `ClusterBuildParent`) for the deposit factory to register on. */
function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger("uw-test"))
  )
}

/** Build one `ChainTokenAmount` entry for a native (chain, token) pair. */
function entry(
  chainCode: number,
  tokenCode: number,
  amount: bigint
): ChainTokenAmount {
  return {
    chain_code: chainCode,
    amount: TokenAmount.create({ tokenCode: BigInt(tokenCode), amount })
  }
}

/** The step input kinds of a group's Nth child phase (a `ClusterBuildPhase`). */
function stepKinds(group: ClusterBuildPhaseGroup, index: number): string[] {
  return (group.children[index] as ClusterBuildPhase).steps.map(
    step => (step.input as { kind: string }).kind
  )
}

describe("WireUnderwriterTool", () => {
  // ── Pure VALUE helpers ─────────────────────────────────────────────────

  describe("buildDefault", () => {
    it("builds one entry per default pair (WIRE, ETH, SOL) at DefaultAmount", () => {
      const built = WireUnderwriterTool.buildDefault()
      expect(built.map(e => e.chain_code)).toEqual([
        WireChain,
        EthChain,
        SolChain
      ])
      expect(
        built.every(e => e.amount.amount === WireUnderwriterTool.DefaultAmount)
      ).toBe(true)
      expect(built[1].amount.tokenCode).toBe(BigInt(EthToken))
      expect(built[2].amount.tokenCode).toBe(BigInt(SolToken))
    })

    it("returns a fresh array (callers may mutate without aliasing defaults)", () => {
      const a = WireUnderwriterTool.buildDefault()
      const b = WireUnderwriterTool.buildDefault()
      expect(a).not.toBe(b)
    })
  })

  describe("parseJson", () => {
    const uniformJson = [
      {
        chain_code: EthChain,
        amount: TokenAmount.toJson(
          TokenAmount.create({ tokenCode: BigInt(EthToken), amount: 5n })
        )
      }
    ]

    it("fans a uniform (Array<ChainTokenAmount>) input out to every underwriter", () => {
      const parsed = WireUnderwriterTool.parseJson(uniformJson, 3)
      expect(parsed).toHaveLength(3)
      parsed.forEach(list => {
        expect(list).toHaveLength(1)
        expect(list[0].chain_code).toBe(EthChain)
        expect(list[0].amount.amount).toBe(5n)
      })
    })

    it("keeps a varied (Array<Array<ChainTokenAmount>>) input per underwriter", () => {
      const varied = [uniformJson, [...uniformJson, ...uniformJson]]
      const parsed = WireUnderwriterTool.parseJson(varied, 2)
      expect(parsed).toHaveLength(2)
      expect(parsed[0]).toHaveLength(1)
      expect(parsed[1]).toHaveLength(2)
    })

    it("throws when a varied input's outer length != underwriterCount", () => {
      expect(() => WireUnderwriterTool.parseJson([uniformJson], 2)).toThrow(
        /outer array length/
      )
    })

    it("throws on a non-array input", () => {
      expect(() => WireUnderwriterTool.parseJson({ nope: true }, 1)).toThrow(
        /must be an array/
      )
    })

    it("treats an empty array as 'use defaults' per underwriter", () => {
      const parsed = WireUnderwriterTool.parseJson([], 2)
      expect(parsed).toHaveLength(2)
      expect(parsed[0].map(e => e.chain_code)).toEqual([
        WireChain,
        EthChain,
        SolChain
      ])
    })
  })

  describe("load", () => {
    it("returns the fanned-out defaults when no file path is given", () => {
      const loaded = WireUnderwriterTool.load(null, 2)
      expect(loaded).toHaveLength(2)
      loaded.forEach(list =>
        expect(list.map(e => e.chain_code)).toEqual([
          WireChain,
          EthChain,
          SolChain
        ])
      )
    })

    it("throws when underwriterCount is not positive", () => {
      expect(() => WireUnderwriterTool.load(null, 0)).toThrow(
        /must be positive/
      )
    })

    it("parses a supplied JSON file (uniform shape)", () => {
      const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "uw-collat-"))
      const file = Path.join(dir, "collateral.json")
      Fs.writeFileSync(
        file,
        JSON.stringify([
          {
            chain_code: EthChain,
            amount: TokenAmount.toJson(
              TokenAmount.create({ tokenCode: BigInt(EthToken), amount: 7n })
            )
          }
        ])
      )
      try {
        const loaded = WireUnderwriterTool.load(file, 2)
        expect(loaded).toHaveLength(2)
        expect(loaded[0][0].amount.amount).toBe(7n)
      } finally {
        Fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it("throws when the file path does not exist", () => {
      expect(() =>
        WireUnderwriterTool.load("/no/such/collateral.json", 1)
      ).toThrow(/does not exist/)
    })
  })

  // ── Deposit PhaseGroup factory ─────────────────────────────────────────

  describe("deposit", () => {
    it("returns a PhaseGroup with one Phase per underwriter", () => {
      const group = WireUnderwriterTool.planCollateralDeposit(
        newBuild(),
        "uw-collateral",
        "underwriter collateral",
        {},
        ["uwa", "uwb"],
        [
          WireUnderwriterTool.buildDefault(),
          [entry(EthChain, EthToken, WireUnderwriterTool.DefaultAmount)]
        ]
      )
      expect(group).toBeInstanceOf(ClusterBuildPhaseGroup)
      expect(group.children).toHaveLength(2)
      expect(group.children.map(child => child.name)).toEqual([
        "uwa-collateral",
        "uwb-collateral"
      ])
    })

    it("emits ETH-native deposit + SOL airdrop/deposit and skips WIRE for the default plan", () => {
      const group = WireUnderwriterTool.planCollateralDeposit(
        newBuild(),
        "uw-collateral",
        "underwriter collateral",
        {},
        ["uwa"],
        [WireUnderwriterTool.buildDefault()]
      )
      // WIRE → skipped; ETH native → 1 deposit; SOL native → airdrop + deposit.
      expect(stepKinds(group, 0)).toEqual([
        "EthereumCollateralTool.DepositInput",
        "SolanaFundingTool.AirdropInput",
        "SolanaCollateralTool.DepositInput"
      ])
    })

    it("emits a single ETH-native deposit Step for a single ETH entry", () => {
      const group = WireUnderwriterTool.planCollateralDeposit(
        newBuild(),
        "uw-collateral",
        "d",
        {},
        ["uwb"],
        [[entry(EthChain, EthToken, WireUnderwriterTool.DefaultAmount)]]
      )
      expect(stepKinds(group, 0)).toEqual([
        "EthereumCollateralTool.DepositInput"
      ])
      expect((group.children[0] as ClusterBuildPhase).steps[0].actor).toBe(
        Report.Actor.Underwriter
      )
    })

    it("emits an empty Phase for a WIRE-only underwriter (no outpost deposit path)", () => {
      const group = WireUnderwriterTool.planCollateralDeposit(
        newBuild(),
        "uw-collateral",
        "d",
        {},
        ["uwc"],
        [[entry(WireChain, WireChain, WireUnderwriterTool.DefaultAmount)]]
      )
      expect(stepKinds(group, 0)).toEqual([])
    })

    it("emits the non-native ETH steps from config alone — deploy artifacts resolve at RUN time", () => {
      // The mock-token address does not exist when the build constructs its
      // steps (the outpost deploys later in the same build) — the step SET
      // must come from the collateral plan, never from an artifact probe.
      // The old factory-time read silently skipped every non-native leg
      // (2026-07-02 flow-swap-non-native-tokens incident).
      const group = WireUnderwriterTool.planCollateralDeposit(
        newBuild(),
        "uw-collateral",
        "d",
        {},
        ["uwd"],
        [[entry(EthChain, UsdcToken, WireUnderwriterTool.DefaultAmount)]]
      )
      expect(stepKinds(group, 0)).toEqual([
        "EthereumFundingTool.MintErc20Input",
        "EthereumCollateralTool.ApproveErc20Input",
        "EthereumCollateralTool.DepositNonNativeInput"
      ])
    })

    it("throws when the collateral plan length != underwriter count", () => {
      expect(() =>
        WireUnderwriterTool.planCollateralDeposit(
          newBuild(),
          "uw-collateral",
          "d",
          {},
          ["only-one"],
          [
            WireUnderwriterTool.buildDefault(),
            WireUnderwriterTool.buildDefault()
          ]
        )
      ).toThrow(/must equal underwriter count/)
    })
  })
})
