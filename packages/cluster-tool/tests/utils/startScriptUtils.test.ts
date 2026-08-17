import {
  matchesPrefix,
  orderRelocations,
  shellQuote,
  toRelocatableArgv,
  toRelocatableToken,
  StartScriptVariable
} from "@wireio/cluster-tool/utils"
import { execFileSync } from "node:child_process"

describe("startScriptUtils", () => {
  const clusterRelocation = {
      prefix: "/build/cluster",
      variable: StartScriptVariable.CLUSTER_DIR
    },
    nodeRelocation = {
      prefix: "/build/cluster/data/node_00",
      variable: StartScriptVariable.NODE_DIR
    }

  describe("matchesPrefix", () => {
    // THE one prefix predicate — token rewriting, DaemonConfig's shell-test
    // quoting, and the renderer's root assertions all route through it, so
    // these cases pin the contract for all three at once.
    it("matches the prefix itself and anything beneath it", () => {
      expect(matchesPrefix("/build/cluster", "/build/cluster")).toBe(true)
      expect(matchesPrefix("/build/cluster/data/x", "/build/cluster")).toBe(true)
    })

    it("REJECTS a sibling that merely shares the prefix STRING", () => {
      // A bare startsWith would relocate /build/cluster-2 onto $CLUSTER_DIR,
      // silently pointing a daemon at a different cluster's tree.
      expect(matchesPrefix("/build/cluster-2/data/x", "/build/cluster")).toBe(
        false
      )
    })

    it("REJECTS an empty prefix, which would otherwise match everything", () => {
      // A depot-only cluster has no ethereum path. Without this guard the
      // renderer would mark WIRE_ETH_PATH as "referenced" for every daemon and
      // emit a `:?` assertion no depot-only operator can satisfy.
      expect(matchesPrefix("/anything", "")).toBe(false)
    })
  })

  describe("orderRelocations", () => {
    it("puts the longest prefix first so a nested root wins", () => {
      // A node dir lives UNDER the cluster dir; if clusterPath were tried
      // first every node path would relocate to $CLUSTER_DIR.
      expect(
        orderRelocations([clusterRelocation, nodeRelocation]).map(
          entry => entry.variable
        )
      ).toEqual([StartScriptVariable.NODE_DIR, StartScriptVariable.CLUSTER_DIR])
    })

    it("drops empty prefixes so an unset root cannot match everything", () => {
      // A depot-only cluster has no ethereum path; a "" prefix would otherwise
      // match every token via startsWith.
      expect(
        orderRelocations([
          { prefix: "", variable: StartScriptVariable.WIRE_ETH_PATH },
          clusterRelocation
        ])
      ).toEqual([clusterRelocation])
    })
  })

  describe("shellQuote", () => {
    it("renders a literal as an inert single-quoted word", () => {
      expect(shellQuote("/plain/path")).toBe("'/plain/path'")
    })

    it("neutralizes an embedded single quote", () => {
      expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    })

    it("keeps shell metacharacters literal when bash evaluates it", () => {
      const hostile = `a b$(echo pwned)\`echo x\`'q'`,
        printed = execFileSync(
          "bash",
          ["-c", `printf '%s' ${shellQuote(hostile)}`],
          { encoding: "utf8" }
        )
      expect(printed).toBe(hostile)
    })
  })

  describe("toRelocatableToken", () => {
    it("substitutes a matched root and quotes the remainder", () => {
      expect(
        toRelocatableToken("/build/cluster/data/anvil/anvil.json", [
          clusterRelocation
        ])
      ).toBe(`"$CLUSTER_DIR"'/data/anvil/anvil.json'`)
    })

    it("emits the bare variable when the token IS the root", () => {
      expect(toRelocatableToken("/build/cluster", [clusterRelocation])).toBe(
        `"$CLUSTER_DIR"`
      )
    })

    it("quotes an unmatched token whole", () => {
      expect(toRelocatableToken("--flag", [clusterRelocation])).toBe("'--flag'")
    })

    it("does NOT match a sibling directory sharing the prefix string", () => {
      // /build/cluster-other is not under /build/cluster.
      expect(
        toRelocatableToken("/build/cluster-other/x", [clusterRelocation])
      ).toBe("'/build/cluster-other/x'")
    })

    it("expands to the original path when bash evaluates it", () => {
      const word = toRelocatableToken("/build/cluster/data/x y", [
          clusterRelocation
        ]),
        printed = execFileSync(
          "bash",
          ["-c", `CLUSTER_DIR=/moved/elsewhere; printf '%s' ${word}`],
          { encoding: "utf8" }
        )
      expect(printed).toBe("/moved/elsewhere/data/x y")
    })
  })

  describe("toRelocatableArgv", () => {
    it("relocates every token against the ordered table", () => {
      expect(
        toRelocatableArgv(
          ["--config-dir", "/build/cluster/data/node_00", "--verbose"],
          [clusterRelocation, nodeRelocation]
        )
      ).toEqual(["'--config-dir'", `"$NODE_DIR"`, "'--verbose'"])
    })
  })
})
