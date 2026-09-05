import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import {
  DaemonConfig,
  DaemonKind,
  NodeConfig,
  NodeRole
} from "@wireio/cluster-tool/config"
import {
  KiodProcess,
  NodeopProcess
} from "@wireio/cluster-tool/cluster/processes"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { seedProducerOperators } from "../outputs/operatorAccountFixture.js"

const startScript = Steps.startScript,
  validatorSteps = Steps.processes.solanaValidator,
  nodeopSteps = Steps.processes.nodeop

/** The three SHARED-25 deadline flags, exactly as `buildArgs` emits them. */
const MaxTransactionTimeFlag = "--max-transaction-time",
  AbiSerializerMaxTimeFlag = "--abi-serializer-max-time-ms",
  HttpMaxResponseTimeFlag = "--http-max-response-time-ms"

/** The value following `flag` in an argv (each occurrence). */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
}

describe("StartScriptSteps", () => {
  let dir: string
  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "startsteps-"))
    // Every real cluster has one, and `resolveSources` reads it for the node
    // configs' genesis timestamp.
    Fs.writeFileSync(
      Path.join(dir, "genesis.json"),
      JSON.stringify({ initial_timestamp: "2026-01-01T00:00:00.000" })
    )
  })
  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  /** A fixture cluster rooted in this test's sandbox. */
  function cluster() {
    return fixtureConfig({
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      buildPath: Path.join(dir, "build")
    })
  }

  // SHARED-25 AC#2 + AC#3. This pin has to be DIRECT: the argv-equality guard in
  // `StartScriptRenderer.test.ts` feeds ONE options object to both the rendered
  // script and the live process, so a `resolveSources` that resolved the WRONG
  // phase would still compare equal against itself and pass.
  describe("resolveSources — the POST-BOOTSTRAP launch form", () => {
    /**
     * A context whose key store carries every identity `resolveOperator` needs
     * for the planned topology. Operator accounts get K1 material only: their
     * EM / ED pairs are consumed exclusively by the OPP daemon args, which this
     * suite stubs (below), and `buildArgs` renders signature providers only for
     * PRODUCING nodes.
     */
    function seededContext() {
      const ctx = fixtureContext({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        buildPath: Path.join(dir, "build")
      })
      ctx.keyStore.pushNodes({
        index: 0,
        keys: {
          wire: {
            type: KeyType.K1,
            publicKey: "PUB_K1_n0",
            privateKey: "PVT_K1_n0"
          },
          wireFinalizer: {
            type: KeyType.BLS,
            publicKey: "PUB_BLS_n0",
            privateKey: "PVT_BLS_n0",
            proofOfPossession: "SIG_BLS_n0"
          }
        }
      })
      // Producing nodes now resolve one ACCOUNT per hosted producer (each owning its own
      // finalizer key), not the node key set — so the accounts have to exist here.
      seedProducerOperators(ctx)
      NodeConfig.plan(ctx.config)
        .filter(node => NodeConfig.isOperatorRole(node.role))
        .forEach(node => {
          const { batchOperatorLabel, underwriterLabel } = node,
            label = batchOperatorLabel ?? underwriterLabel
          ctx.keyStore.setOperator({
            label,
            publicationLabel: label,
            account: `wireno.${label.replace(/[^a-z1-5]/g, "")}`,
            type:
              batchOperatorLabel != null
                ? OperatorType.BATCH
                : OperatorType.UNDERWRITER,
            wire: {
              type: KeyType.K1,
              publicKey: `PUB_K1_${label}`,
              privateKey: `PVT_K1_${label}`
            }
          })
        })
      // The OPP daemon argv is a separate concern with its own coverage
      // (`NodeopProcessSteps.test.ts`) and needs real EM / ED key material plus
      // prepared outpost artifacts — neither of which says anything about the
      // launch PHASE this block pins.
      jest.spyOn(nodeopSteps, "resolveOperatorDaemonArgs").mockReturnValue([])
      // Same reasoning for the validator's BPF set: it reads a built
      // `liqsol_core` keypair off the wire-solana checkout, and its own
      // threading is pinned by `resolveSolanaValidatorConfig` below.
      jest.spyOn(validatorSteps, "resolvePrograms").mockReturnValue([])
      return ctx
    }

    /** The resolved argv for the first planned node of `role`. */
    function argsForRole(role: NodeRole): string[] {
      const resolved = startScript
        .resolveSources(seededContext())
        .nodeop.find(candidate => candidate.node.role === role)
      expect(resolved).toBeDefined()
      return NodeopProcess.buildArgs(resolved)
    }

    it("resolves a PRODUCER node with no --max-transaction-time and NEITHER timeout flag", () => {
      const args = argsForRole(NodeRole.producer)
      expect(args).not.toContain(MaxTransactionTimeFlag)
      expect(args).not.toContain(AbiSerializerMaxTimeFlag)
      expect(args).not.toContain(HttpMaxResponseTimeFlag)
    })

    it("resolves a BATCH-OPERATOR node with both timeout flags and no --max-transaction-time", () => {
      const args = argsForRole(NodeRole.batch_operator)
      expect(args).not.toContain(MaxTransactionTimeFlag)
      expect(valuesOf(args, AbiSerializerMaxTimeFlag)).toEqual([
        String(NodeopProcess.OperatorAbiSerializerMaxTimeMs)
      ])
      expect(valuesOf(args, HttpMaxResponseTimeFlag)).toEqual([
        String(NodeopProcess.OperatorHttpMaxResponseTimeMs)
      ])
    })

    it("drops --max-transaction-time from EVERY planned node's script argv", () => {
      // Role-blind by design (AC#2), so assert over the whole planned set
      // rather than the two roles sampled above.
      const sources = startScript.resolveSources(seededContext())
      expect(sources.nodeop.length).toBeGreaterThan(0)
      sources.nodeop.forEach(resolved =>
        expect(NodeopProcess.buildArgs(resolved)).not.toContain(
          MaxTransactionTimeFlag
        )
      )
    })
  })

  describe("resolveSolanaValidatorConfig", () => {
    it("threads the validator's BPF programs through — via the PRODUCTION resolver", () => {
      // The regression this pins: the renderer's config once passed NO
      // `programs`, so the rendered argv omitted --upgradeable-program entirely
      // and a script-started validator came up with no opp-outpost program —
      // a one-direction OPP circulation stall, never a startup error.
      //
      // Asserting through `resolveSolanaValidatorConfig` (not a hand-built
      // config) is the point: deleting the `programs:` line makes this FAIL.
      const programs = [
        {
          name: "opp",
          programId: "PID",
          soFile: "/tmp/opp.so",
          upgradeAuthority: "UPGKEY"
        }
      ]
      jest
        .spyOn(validatorSteps, "resolvePrograms")
        .mockReturnValue(programs)

      const resolved = startScript.resolveSolanaValidatorConfig(cluster())
      expect(validatorSteps.resolvePrograms).toHaveBeenCalled()
      expect(resolved.programs).toEqual(programs)
    })

    it("renders those programs into the daemon's argv", () => {
      jest.spyOn(validatorSteps, "resolvePrograms").mockReturnValue([
        {
          name: "opp",
          programId: "PID",
          soFile: "/tmp/opp.so",
          upgradeAuthority: "UPGKEY"
        }
      ])
      const config = cluster(),
        daemon = DaemonConfig.plan(config, {
          nodeop: [],
          solanaValidator: startScript.resolveSolanaValidatorConfig(config)
        }).find(candidate => candidate.kind === DaemonKind.solanaValidator)
      expect(daemon.argv).toEqual(
        expect.arrayContaining([
          "--upgradeable-program",
          "PID",
          "/tmp/opp.so",
          "UPGKEY"
        ])
      )
    })
  })

  describe("writeAll", () => {
    /** Sources with exactly one daemon (kiod) — enough to exercise the sweep. */
    function kiodOnlySources(config: ReturnType<typeof cluster>) {
      return {
        nodeop: [],
        kiod: KiodProcess.resolveConfig(
          {
            binary: Path.join(config.buildPath, "bin", "kiod"),
            walletPath: Path.join(config.clusterPath, "wallet")
          },
          { port: 8900 }
        )
      }
    }

    it("DELETES pre-existing scripts before rendering", () => {
      // Rebind clones the local tree wholesale, so a daemon the external model
      // drops would otherwise keep its LOCAL-port script — which the Verify
      // scan cannot flag, because it never enumerates that file.
      const config = cluster(),
        staleDir = Path.join(config.dataPath, "anvil"),
        stale = Path.join(staleDir, "start.sh")
      Fs.mkdirSync(staleDir, { recursive: true })
      Fs.writeFileSync(stale, "#!/usr/bin/env bash\n# STALE local-port script\n")

      startScript.writeAll(config, kiodOnlySources(config))

      expect(Fs.existsSync(stale)).toBe(false)
    })

    it("writes a script for every planned daemon", () => {
      const config = cluster(),
        written = startScript.writeAll(config, kiodOnlySources(config))
      expect(written.length).toBeGreaterThan(0)
      written.forEach(file => expect(Fs.existsSync(file)).toBe(true))
    })

    it("returns paths that match the daemon-directory convention", () => {
      const config = cluster(),
        written = startScript.writeAll(config, kiodOnlySources(config))
      expect(written).toContain(
        DaemonConfig.startScriptFile(
          DaemonConfig.daemonPath(config.dataPath, KiodProcess.ProcessLabel)
        )
      )
    })
  })

  describe("write", () => {
    it("creates the daemon directory when it does not exist", () => {
      // A ManagedProcess creates its dir in start(), not at construction, and
      // the debugging server's is created by the bundle-copy step — so the
      // emitter must not assume either has run.
      const config = cluster(),
        daemon: DaemonConfig = {
          kind: DaemonKind.kiod,
          label: "kiod",
          daemonPath: Path.join(config.dataPath, "kiod"),
          exe: "/bin/true",
          argv: ["--flag"],
          conditions: [],
          relocations: []
        }
      expect(Fs.existsSync(daemon.daemonPath)).toBe(false)
      const file = startScript.write(config, daemon)
      expect(Fs.existsSync(file)).toBe(true)
    })

    /** A daemon descriptor writing into `dataPath/<label>`. */
    function kiodDaemon(config: ReturnType<typeof cluster>): DaemonConfig {
      return {
        kind: DaemonKind.kiod,
        label: "kiod",
        daemonPath: Path.join(config.dataPath, "kiod"),
        exe: "/bin/true",
        argv: ["--flag"],
        conditions: [],
        relocations: []
      }
    }

    it("emits an EXECUTABLE script", () => {
      // The scripts are meant to be run as `./start.sh`, not handed to an
      // interpreter, so the executable bit is part of the deliverable.
      const config = cluster(),
        file = startScript.write(config, kiodDaemon(config))
      expect(Fs.statSync(file).mode & 0o111).not.toBe(0)
    })

    it("RE-applies the executable bit when overwriting an existing script", () => {
      // writeFileSync's `mode` applies only on CREATE, so a re-render (Rebind,
      // or a repeated create into the same tree) would silently keep whatever
      // bits the previous file had.
      const config = cluster(),
        daemon = kiodDaemon(config),
        file = startScript.write(config, daemon)
      Fs.chmodSync(file, 0o644)
      startScript.write(config, daemon)
      expect(Fs.statSync(file).mode & 0o111).not.toBe(0)
    })
  })

  describe("runEmit", () => {
    it("FAILS LOUDLY on a label the enumeration does not plan", async () => {
      // A silent return would record a PASSING Report step that wrote no file,
      // defeating the per-daemon validation this step exists to provide.
      const config = cluster(),
        ctx = { config } as Parameters<typeof startScript.runEmit>[0]
      jest
        .spyOn(startScript, "resolveSources")
        .mockReturnValue({ nodeop: [] })
      await expect(
        startScript.runEmit(
          ctx,
          { kind: "StartScriptSteps.EmitInput", label: "not-a-daemon" },
          new AbortController().signal
        )
      ).rejects.toThrow(/no planned daemon named/)
    })

    it("honours an already-aborted signal", async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        startScript.runEmit(
          { config: cluster() } as Parameters<typeof startScript.runEmit>[0],
          { kind: "StartScriptSteps.EmitInput", label: "kiod" },
          controller.signal
        )
      ).rejects.toThrow()
    })
  })
})
