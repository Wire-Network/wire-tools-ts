import Path from "node:path"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { DaemonConfig, DaemonKind } from "@wireio/cluster-tool/config"
import { StartScriptVariable } from "@wireio/cluster-tool/utils"
import {
  AnvilProcess,
  KiodProcess,
  SolanaValidatorProcess
} from "@wireio/cluster-tool/cluster/processes"
import { fixtureConfig, PersistedFixture } from "./clusterConfigFixture.js"

describe("DaemonConfig", () => {
  const cluster = fixtureConfig({
    clusterPath: "/c",
    dataPath: "/c/data",
    buildPath: "/build"
  })

  describe("daemonPath", () => {
    it("maps a dashed label onto its underscored directory", () => {
      // Mirrors ManagedProcess.pidFile's derivation, so the script lands beside
      // the pidfile rather than in an invented sibling directory.
      expect(DaemonConfig.daemonPath("/c/data", "solana-test-validator")).toBe(
        Path.join("/c/data", "solana_test_validator")
      )
    })

    it("leaves an undashed label alone", () => {
      expect(DaemonConfig.daemonPath("/c/data", "kiod")).toBe(
        Path.join("/c/data", "kiod")
      )
    })
  })

  describe("plannedLabels", () => {
    it("covers every daemon of a local cluster", () => {
      const labels = DaemonConfig.plannedLabels(cluster)
      expect(labels).toEqual(
        expect.arrayContaining([
          AnvilProcess.ProcessLabel,
          SolanaValidatorProcess.ProcessLabel,
          KiodProcess.ProcessLabel,
          DaemonConfig.DebuggingServerSubpath
        ])
      )
      // Nodes are included too — the count is nodes + 4.
      expect(labels.length).toBeGreaterThan(4)
    })

    it("OMITS anvil + validator in external-outpost mode", () => {
      // An external cluster runs against REMOTE chains. Emitting these would
      // ship two local-port scripts for daemons that do not exist.
      const external: ClusterConfig = {
          ...cluster,
          externalOutposts: PersistedFixture.externalOutposts ?? ({} as never)
        },
        labels = DaemonConfig.plannedLabels(external)
      expect(labels).not.toContain(AnvilProcess.ProcessLabel)
      expect(labels).not.toContain(SolanaValidatorProcess.ProcessLabel)
      expect(labels).toContain(KiodProcess.ProcessLabel)
    })

    it("OMITS the debugging server when it is disabled", () => {
      // A label with no corresponding daemon would make runEmit's Assert fire
      // and hard-fail create for every server-disabled cluster.
      expect(
        DaemonConfig.plannedLabels({
          ...cluster,
          debuggingServerEnabled: false
        })
      ).not.toContain(DaemonConfig.DebuggingServerSubpath)
    })
  })

  describe("existingStartScriptFiles", () => {
    /** A fake fs: `dirs` are entries of dataPath; `files` exist. */
    function probes(dirs: string[], files: string[]) {
      return {
        existsSync: (path: string) => path === "/c/data" || files.includes(path),
        readdirSync: () => dirs
      }
    }

    it("finds a start.sh one directory deep", () => {
      const { existsSync, readdirSync } = probes(
        ["anvil", "node_00"],
        ["/c/data/anvil/start.sh"]
      )
      expect(
        DaemonConfig.existingStartScriptFiles("/c/data", existsSync, readdirSync)
      ).toEqual([Path.join("/c/data", "anvil", "start.sh")])
    })

    it("enumerates from the TREE, so a daemon the model dropped is still found", () => {
      // This is what lets Rebind delete a cloned local-port script for a daemon
      // the external model no longer plans — the Verify scan cannot flag a file
      // nobody enumerates.
      const { existsSync, readdirSync } = probes(
        ["anvil"],
        ["/c/data/anvil/start.sh"]
      )
      expect(
        DaemonConfig.existingStartScriptFiles("/c/data", existsSync, readdirSync)
      ).toHaveLength(1)
    })

    it("returns nothing when the data dir is absent", () => {
      expect(
        DaemonConfig.existingStartScriptFiles(
          "/c/data",
          () => false,
          () => []
        )
      ).toEqual([])
    })
  })

  describe("clusterRelocations", () => {
    it("maps each host root to its variable", () => {
      const byVariable = new Map(
        DaemonConfig.clusterRelocations(cluster).map(entry => [
          entry.variable,
          entry.prefix
        ])
      )
      expect(byVariable.get(StartScriptVariable.CLUSTER_DIR)).toBe("/c")
      expect(byVariable.get(StartScriptVariable.WIRE_PREFIX_PATH)).toBe("/build")
    })
  })

  describe("plan — PATH-resolved executables", () => {
    /** The planned daemon of `kind`, from a full local source set. */
    function daemonOfKind(kind: DaemonKind) {
      return DaemonConfig.plan(cluster, {
        nodeop: [],
        anvil: AnvilProcess.resolveConfig(
          {},
          { binary: "/home/someone/.foundry/bin/anvil", port: 1 }
        ),
        solanaValidator: SolanaValidatorProcess.resolveConfig(
          {},
          {
            binary: "/home/someone/.local/bin/solana-test-validator",
            rpcPort: 2,
            faucetPort: 3,
            gossipPort: 4,
            dynamicPortRange: { first: 10, last: 20 }
          }
        ),
        kiod: KiodProcess.resolveConfig(
          { binary: "/build/bin/kiod", walletPath: "/c/wallet" },
          { port: 5 }
        ),
        debuggingServer: { address: "127.0.0.1", port: 6 }
      }).find(candidate => candidate.kind === kind)
    }

    it.each([
      [DaemonKind.anvil, DaemonConfig.AnvilBinEnvironmentVariable],
      [
        DaemonKind.solanaValidator,
        DaemonConfig.SolanaValidatorBinEnvironmentVariable
      ],
      [DaemonKind.debuggingServer, DaemonConfig.NodeBinEnvironmentVariable]
    ])(
      "%s declares an exe indirection so the build host's path is not frozen",
      (kind, variable) => {
        // `which()` yields e.g. /home/<user>/.foundry/bin/anvil — under NO
        // relocatable root, so freezing it ships a script that runs only on the
        // build host. Asserted at the PRODUCER (plan*), not just where the
        // renderer consumes it.
        const daemon = daemonOfKind(kind as DaemonKind)
        expect(daemon.exeEnvironmentVariable).toBe(variable)
        expect(daemon.exeCommandName).toBeTruthy()
      }
    )

    it("NAMESPACES every override var, so none collides with an ambient one", () => {
      // `NODE_BIN` is already set by common node version managers — to the bin
      // DIRECTORY. An unprefixed "${NODE_BIN:-$(command -v node)}" therefore
      // never reaches its fallback and execs a directory:
      // `cannot execute: Is a directory`. Caught by RUNNING a real emitted
      // script; unprefixed names must never come back.
      ;[
        DaemonConfig.AnvilBinEnvironmentVariable,
        DaemonConfig.SolanaValidatorBinEnvironmentVariable,
        DaemonConfig.NodeBinEnvironmentVariable
      ].forEach(variable => expect(variable).toMatch(/^WIRE_/))
    })

    it("kiod does NOT indirect — its binary lives under the build root", () => {
      const daemon = daemonOfKind(DaemonKind.kiod)
      expect(daemon.exeCommandName).toBeUndefined()
      // …and it carries no $NODE_DIR relocation: its argv addresses the cluster
      // wallet dir exclusively, never its own data/kiod directory.
      expect(daemon.relocations).toEqual([])
    })
  })
})
