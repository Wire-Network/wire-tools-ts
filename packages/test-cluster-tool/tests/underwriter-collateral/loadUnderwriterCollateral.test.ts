import Fs from "node:fs"
import OS from "node:os"
import Path from "node:path"
import { ChainKind, TokenKind } from "@wireio/opp-typescript-models"
import {
  DefaultUnderwriterCollateralAmount,
  DefaultUnderwriterCollateralPairs,
  buildDefaultUnderwriterCollateral,
  loadUnderwriterCollateral,
  parseUnderwriterCollateralJson
} from "@wireio/test-cluster-tool"

const TempDirPrefix = "uw-collateral-test-"

let tempDir: string

beforeEach(() => {
  tempDir = Fs.mkdtempSync(Path.join(OS.tmpdir(), TempDirPrefix))
})

afterEach(() => {
  Fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeJsonFile(name: string, value: unknown): string {
  const filePath = Path.join(tempDir, name)
  Fs.writeFileSync(filePath, JSON.stringify(value))
  return filePath
}

describe("buildDefaultUnderwriterCollateral", () => {
  it("returns one ChainTokenAmount per integrated default pair with the default amount", () => {
    const entries = buildDefaultUnderwriterCollateral()
    expect(entries.length).toBe(DefaultUnderwriterCollateralPairs.length)
    entries.forEach(entry => {
      expect(entry.chain).toBeDefined()
      expect(entry.amount).toBeDefined()
      expect(entry.amount!.amount).toBe(DefaultUnderwriterCollateralAmount)
      expect(entry.chain!.id).toBe(0)
    })
    const present = entries
      .map(e => `${e.chain!.kind}/${e.amount!.kind}`)
      .sort()
    const expected = DefaultUnderwriterCollateralPairs.map(
      p => `${p.chain}/${p.tokenKind}`
    ).sort()
    expect(present).toEqual(expected)
  })

  it("returns a fresh array on each call (mutation safe)", () => {
    const a = buildDefaultUnderwriterCollateral()
    const b = buildDefaultUnderwriterCollateral()
    expect(a).not.toBe(b)
    a.length = 0
    expect(b.length).toBe(DefaultUnderwriterCollateralPairs.length)
  })
})

describe("loadUnderwriterCollateral — no file → defaults", () => {
  it("fans the default plan out to every underwriter", () => {
    const plan = loadUnderwriterCollateral(undefined, 3)
    expect(plan.length).toBe(3)
    plan.forEach(entries => {
      expect(entries.length).toBe(DefaultUnderwriterCollateralPairs.length)
    })
  })

  it("throws when underwriterCount is 0 or negative", () => {
    expect(() => loadUnderwriterCollateral(undefined, 0)).toThrow(
      /underwriterCount must be positive/
    )
    expect(() => loadUnderwriterCollateral(undefined, -1)).toThrow(
      /underwriterCount must be positive/
    )
  })

  it("throws on a missing file path", () => {
    expect(() =>
      loadUnderwriterCollateral(Path.join(tempDir, "does-not-exist.json"), 2)
    ).toThrow(/does not exist/)
  })

  it("throws on invalid JSON", () => {
    const filePath = Path.join(tempDir, "bad.json")
    Fs.writeFileSync(filePath, "{not-json")
    expect(() => loadUnderwriterCollateral(filePath, 2)).toThrow(
      /not valid JSON/
    )
  })
})

describe("parseUnderwriterCollateralJson — uniform shape", () => {
  it("fans a single entry list out to every underwriter", () => {
    const plan = parseUnderwriterCollateralJson(
      [
        {
          chain: { kind: "CHAIN_KIND_ETHEREUM", id: 0 },
          amount: { kind: "TOKEN_KIND_ETH", amount: "42" }
        }
      ],
      3
    )
    expect(plan.length).toBe(3)
    plan.forEach(entries => {
      expect(entries.length).toBe(1)
      const [e] = entries
      expect(e.chain!.kind).toBe(ChainKind.ETHEREUM)
      expect(e.amount!.kind).toBe(TokenKind.ETH)
      expect(e.amount!.amount).toBe(42n)
    })
  })

  it("treats an empty array as 'use defaults'", () => {
    const plan = parseUnderwriterCollateralJson([], 2)
    expect(plan.length).toBe(2)
    plan.forEach(entries => {
      expect(entries.length).toBe(DefaultUnderwriterCollateralPairs.length)
    })
  })

  it("accepts numeric enum encodings (proto wire format)", () => {
    const plan = parseUnderwriterCollateralJson(
      [
        {
          chain: { kind: ChainKind.SOLANA, id: 0 },
          amount: { kind: TokenKind.SOL, amount: "10000" }
        }
      ],
      1
    )
    expect(plan[0][0].chain!.kind).toBe(ChainKind.SOLANA)
    expect(plan[0][0].amount!.kind).toBe(TokenKind.SOL)
    expect(plan[0][0].amount!.amount).toBe(10_000n)
  })
})

describe("parseUnderwriterCollateralJson — varied shape", () => {
  it("preserves per-underwriter entries when outer length matches", () => {
    const plan = parseUnderwriterCollateralJson(
      [
        [
          {
            chain: { kind: ChainKind.ETHEREUM, id: 0 },
            amount: { kind: TokenKind.ETH, amount: "50" }
          }
        ],
        [
          {
            chain: { kind: ChainKind.ETHEREUM, id: 0 },
            amount: { kind: TokenKind.ETH, amount: "100" }
          }
        ]
      ],
      2
    )
    expect(plan.length).toBe(2)
    expect(plan[0][0].amount!.amount).toBe(50n)
    expect(plan[1][0].amount!.amount).toBe(100n)
  })

  it("rejects mismatched outer length", () => {
    expect(() =>
      parseUnderwriterCollateralJson(
        [
          [
            {
              chain: { kind: ChainKind.ETHEREUM, id: 0 },
              amount: { kind: TokenKind.ETH, amount: "1" }
            }
          ]
        ],
        3
      )
    ).toThrow(/outer array length 1 must equal/)
  })
})

describe("loadUnderwriterCollateral — round-trip from JSON file", () => {
  it("parses a uniform file written to disk", () => {
    const filePath = writeJsonFile("uniform.json", [
      {
        chain: { kind: ChainKind.SOLANA, id: 0 },
        amount: { kind: TokenKind.SOL, amount: "777" }
      }
    ])
    const plan = loadUnderwriterCollateral(filePath, 2)
    expect(plan.length).toBe(2)
    expect(plan[0][0].chain!.kind).toBe(ChainKind.SOLANA)
    expect(plan[1][0].amount!.amount).toBe(777n)
  })

  it("parses a varied file written to disk", () => {
    const filePath = writeJsonFile("varied.json", [
      [
        {
          chain: { kind: ChainKind.ETHEREUM, id: 0 },
          amount: { kind: TokenKind.ETH, amount: "1" }
        }
      ],
      [
        {
          chain: { kind: ChainKind.SOLANA, id: 0 },
          amount: { kind: TokenKind.SOL, amount: "2" }
        }
      ]
    ])
    const plan = loadUnderwriterCollateral(filePath, 2)
    expect(plan[0][0].chain!.kind).toBe(ChainKind.ETHEREUM)
    expect(plan[1][0].chain!.kind).toBe(ChainKind.SOLANA)
  })
})
