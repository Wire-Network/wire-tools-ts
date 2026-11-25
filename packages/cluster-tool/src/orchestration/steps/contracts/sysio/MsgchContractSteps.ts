import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"

import { mapOutpostChains, type PerOutpostChain } from "@wireio/cluster-tool-shared"

import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"
import { EpochContractSteps } from "./EpochContractSteps.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.msgch` (message channel) actions. */
export namespace MsgchContractSteps {
  /**
   * `sysio.msgch::bootstrap` — the network bootstrap: the genesis advance (epoch 0 → 1) of
   * every active outpost chain, each starting its own consensus epoch 1.
   */
  export function planBootstrap<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runBootstrap
    )
  }

  /** Named runner — `sysio.msgch::bootstrap` (empty payload). */
  export async function runBootstrap<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .actions.bootstrap.invoke({})
  }

  /** Input for {@link planBootchain} — the generated `msgch::bootchain` data. */
  export interface BootchainInput extends StepInput {
    readonly kind: "MsgchContractSteps.BootchainInput"
    /** The action data: the outpost chain whose genesis advance runs. */
    readonly data: SysioContracts.SysioMsgchBootchainAction
  }

  /**
   * `sysio.msgch::bootchain` — the genesis advance of one outpost chain activated after the
   * network genesis, so it starts its own consensus epoch 1. Refused before the network
   * genesis and once the chain's epoch has started.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain to start.
   * @returns The `sysio.msgch` step.
   */
  export function planBootchain<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioMsgchBootchainAction
  ): ClusterBuildStep<C, BootchainInput> {
    return ClusterBuildStep.create<C, BootchainInput>(
      actor,
      name,
      description,
      options,
      { kind: "MsgchContractSteps.BootchainInput", data },
      runBootchain
    )
  }

  /** Named runner — `sysio.msgch::bootchain` for the input's chain. */
  export async function runBootchain<C extends ClusterBuildContext>(
    ctx: C,
    input: BootchainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .actions.bootchain.invoke(input.data)
  }

  /** Input for {@link planChkcons} — the generated `msgch::chkcons` data. */
  export interface ChkconsInput extends StepInput {
    readonly kind: "MsgchContractSteps.ChkconsInput"
    /** The action data: the outpost chain whose envelope consensus is cranked. */
    readonly data: SysioContracts.SysioMsgchChkconsAction
  }

  /**
   * `sysio.msgch::chkcons` — crank one outpost chain's envelope consensus: re-tallies an
   * undecided current epoch, and advances a decided one once the chain is due (`sysio.epoch`
   * `due_at`: it has traffic, its minimum duration has passed since its epoch start and its
   * traffic wait since that traffic). A decided epoch on an idle chain stays current.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain to crank.
   * @returns The `sysio.msgch` step.
   */
  export function planChkcons<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioMsgchChkconsAction
  ): ClusterBuildStep<C, ChkconsInput> {
    return ClusterBuildStep.create<C, ChkconsInput>(
      actor,
      name,
      description,
      options,
      { kind: "MsgchContractSteps.ChkconsInput", data },
      runChkcons
    )
  }

  /** Named runner — `sysio.msgch::chkcons` for the input's chain (waits for finality so
   *  repeated cranks don't collide on a shared TAPOS reference). */
  export async function runChkcons<C extends ClusterBuildContext>(
    ctx: C,
    input: ChkconsInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.msgch).actions.chkcons.invoke(input.data)
  }

  // ── Reads (execute freely inside runners / verify steps) ─────────────────

  /**
   * Row ceiling of the `outpcons` read: the table holds one row per outpost chain, so a read
   * that still reports `more` is refused rather than trusted.
   */
  export const OutpostConsensusRowLimit = 16

  /**
   * Every outpost chain's `sysio.msgch::outpcons` row from ONE read: the epoch whose winner it
   * accepted last, that winner's checksum and the chain's inbound tips.
   *
   * @param ctx - The build context.
   * @returns Each outpost chain's row (absent for a chain whose first winner is not yet accepted).
   * @throws When the read is truncated at {@link OutpostConsensusRowLimit}.
   */
  export async function readOutpostConsensus<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<PerOutpostChain<SysioContracts.SysioMsgchOutpostConsensusEntryType>> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .tables.outpcons.query({ limit: OutpostConsensusRowLimit })
    Assert.ok(
      !more,
      `MsgchContractSteps: sysio.msgch::outpcons has more than ${OutpostConsensusRowLimit} rows; the read is truncated`
    )
    return mapOutpostChains(chain => EpochContractSteps.findChainRow(rows, chain))
  }
}
