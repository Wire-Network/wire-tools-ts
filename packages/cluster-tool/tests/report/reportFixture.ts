import { Report } from "@wireio/cluster-tool/report"

/** A single all-ok phase. */
export function createSuccessReport(): Report {
  const phase = new Report.PhaseBuilder("Deploy", "deploy contracts", Date.now())
    .push(
      Report.StepResult.ok(
        {
          name: "deploy-opreg",
          description: "setcode sysio.opreg",
          actor: Report.Actor.Sysio,
          input: { contract: "opreg" }
        },
        120
      )
    )
    .build()
  return new Report().push(phase)
}

/**
 * A failed step whose typed input nests bigints and a Uint8Array — the shapes
 * flow step inputs routinely carry (bond amounts, wei, recipient bytes).
 * Renderers must plainify before JSON.stringify or the FAILURE path throws.
 */
export function createBigintFailureReport(): Report {
  const phase = new Report.PhaseBuilder("DepositEthereum", "operator bonds ETH", Date.now())
    .push(
      Report.StepResult.failed(
        {
          name: "deposit-ethereum",
          description: "OperatorRegistry.deposit",
          actor: Report.Actor.User,
          input: {
            bondAmountWei: 2_000_000n,
            tokenCode: 84606560763904n,
            recipientBytes: Uint8Array.of(0xde, 0xad, 0xbe, 0xef)
          }
        },
        450,
        new Error("execution reverted: insufficient bond")
      )
    )
    .build()
  return new Report().push(phase)
}

/**
 * A phase with an ok step then a skipped tail and NO failed step — the
 * stale-abort shape. Every step must be ok for a phase to succeed, so this
 * phase is failed; the header additionally annotates the skipped count.
 */
export function createSkippedTailReport(): Report {
  const phase = new Report.PhaseBuilder(
    "PhaseA",
    "swap via underwriter race",
    Date.now()
  )
    .push(
      Report.StepResult.ok(
        {
          name: "quote",
          description: "compute quote",
          actor: Report.Actor.Sysio,
          input: null
        },
        5
      ),
      Report.StepResult.skipped({
        name: "confirm",
        description: "await CONFIRMED",
        actor: Report.Actor.Underwriter,
        input: null
      }),
      Report.StepResult.skipped({
        name: "payout",
        description: "user receives SOL",
        actor: Report.Actor.SolanaOutpost,
        input: null
      })
    )
    .build()
  return new Report().push(phase)
}

/** One ok phase, then a phase with a failed step + a skipped step. */
export function createFailureReport(): Report {
  const deploy = new Report.PhaseBuilder("Deploy", "deploy contracts", Date.now())
    .push(
      Report.StepResult.ok(
        {
          name: "deploy-opreg",
          description: "setcode sysio.opreg",
          actor: Report.Actor.Sysio,
          input: { contract: "opreg" }
        },
        120
      )
    )
    .build()
  const deposit = new Report.PhaseBuilder("DepositSOL", "operator bonds SOL", Date.now())
    .push(
      Report.StepResult.failed(
        {
          name: "relay",
          description: "relay DEPOSIT_REQUEST",
          actor: Report.Actor.BatchOperator,
          input: { chain: "SOLANA", amount: "1000" }
        },
        300,
        new Error("timed out waiting for balance")
      )
    )
    .push(
      Report.StepResult.skipped({
        name: "credit",
        description: "credit balance row",
        actor: Report.Actor.Sysio,
        input: null
      })
    )
    .build()
  return new Report().push(deploy, deposit)
}

/**
 * A nested tree: Bootstrap group → (Processes sub-group → Kiod phase) +
 * Registry phase; a step carrying recorded client calls (`extra`) and a
 * failed step with `extra` in a second top-level group.
 */
export function createNestedReport(): Report {
  const kiod = new Report.PhaseBuilder("Kiod", "start kiod", Date.now())
    .push(
      Report.StepResult.ok(
        {
          name: "start-kiod",
          description: "spawn kiod",
          actor: Report.Actor.Sysio,
          input: null
        },
        40,
        { calls: [{ client: "clio", kind: "cli", command: ["clio", "wallet", "create"], ok: true }] }
      )
    )
    .build()
  const registry = new Report.PhaseBuilder("Registry", "seed registry", Date.now())
    .push(
      Report.StepResult.ok(
        {
          name: "regchain",
          description: "register chains",
          actor: Report.Actor.Sysio,
          input: { chains: 3 }
        },
        90
      )
    )
    .build()
  const processes = Report.Group.from("Processes", "daemon startup", [kiod], 50)
  const bootstrap = Report.Group.from(
    "Bootstrap",
    "cluster prerequisites",
    [processes, registry],
    150
  )
  const swap = new Report.PhaseBuilder("Swap", "swap phase", Date.now())
    .push(
      Report.StepResult.failed(
        {
          name: "request-swap",
          description: "user swaps",
          actor: Report.Actor.User,
          input: { amount: "100000" }
        },
        200,
        new Error("variance exceeded tolerance"),
        { calls: [{ client: "ethereum", kind: "rpc", method: "eth_sendRawTransaction", ok: false }] }
      )
    )
    .build()
  const scenario = Report.Group.from("Scenario", "the swap scenario", [swap], 210)
  return new Report().push(bootstrap, scenario)
}
